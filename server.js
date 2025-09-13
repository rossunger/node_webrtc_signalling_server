const WebSocket = require('ws');
const crypto = require('crypto');
const { EnhancedSequentialCodeGenerator } = require('./sequential_code_generator');
const codeGenerator = new EnhancedSequentialCodeGenerator();

const MAX_PEERS = 4096;
const MAX_LOBBIES = 1024*1024;
const PORT = process.env.PORT || 5050;
const ALFNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

const NO_LOBBY_TIMEOUT = 1000;
const SEAL_CLOSE_TIMEOUT = 10000;
const PING_INTERVAL = 10000;

const STR_NO_LOBBY = 'Have not joined lobby yet';
const STR_HOST_DISCONNECTED = 'Room host has disconnected';
const STR_ONLY_HOST_CAN_SEAL = 'Only host can seal the lobby';
const STR_SEAL_COMPLETE = 'Seal complete';
const STR_TOO_MANY_LOBBIES = 'Too many lobbies open, disconnecting';
const STR_ALREADY_IN_LOBBY = 'Already in a lobby';
const STR_LOBBY_DOES_NOT_EXISTS = 'Lobby does not exists';
const STR_LOBBY_IS_SEALED = 'Lobby is sealed';
const STR_INVALID_FORMAT = 'Invalid message format';
const STR_NEED_LOBBY = 'Invalid message when not in a lobby';
const STR_SERVER_ERROR = 'Server error, lobby not found';
const STR_INVALID_DEST = 'Invalid destination';
const STR_INVALID_CMD = 'Invalid command';
const STR_TOO_MANY_PEERS = 'Too many peers connected';
const STR_INVALID_TRANSFER_MODE = 'Invalid transfer mode, must be text';
const STR_NEW_HOST = 'You are now the host';
const STR_HOST_CHANGED = 'Host has changed';

const CMD = {
	JOIN: 0,
	ID: 1,
	PEER_CONNECT: 2,
	PEER_DISCONNECT: 3,
	OFFER: 4,
	ANSWER: 5,
	CANDIDATE: 6,
	SEAL: 7,
	HOST_CHANGED: 8,
	GAME_STATE: 9,
	SAVE_GAME: 10,
};

// Simple in-memory database for saved games
// In production, replace this with your actual database
class GameStateDB {
	constructor() {
		this.savedGames = new Map();
	}

	async saveGame(joinCode, gameState) {
		try {
			this.savedGames.set(joinCode, {
				gameState,
				timestamp: Date.now()
			});
			console.log(`Saved game state for lobby ${joinCode}`);
			return true;
		} catch (error) {
			console.error('Error saving game state:', error);
			return false;
		}
	}

	async loadGame(joinCode) {
		try {
			const savedGame = this.savedGames.get(joinCode);
			if (savedGame) {
				// Remove from database after loading (single use)
				this.savedGames.delete(joinCode);
				return savedGame.gameState;
			}
			return null;
		} catch (error) {
			console.error('Error loading game state:', error);
			return null;
		}
	}

	async hasGame(joinCode) {
		return this.savedGames.has(joinCode);
	}
}

const gameStateDB = new GameStateDB();

function randomInt(low, high) {
	return Math.floor(Math.random() * (high - low + 1) + low);
}

function randomId() {
	return Math.abs(new Int32Array(crypto.randomBytes(4).buffer)[0]);
}

function randomSecret() {
	let out = '';
	for (let i = 0; i < CODE_LENGTH; i++) {
		out += ALFNUM[randomInt(0, ALFNUM.length - 1)];
	}
	return out;
}

function ProtoMessage(type, id, data) {
	return JSON.stringify({
		'type': type,
		'id': id,
		'data': data || '',
	});
}

const wss = new WebSocket.Server({ port: PORT });

console.log("listening on ws://localhost:" + PORT);

class ProtoError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

class Peer {
	constructor(id, ws) {
		this.id = id;
		this.ws = ws;
		this.lobby = '';
		// Close connection after 1 sec if client has not joined a lobby
		this.timeout = setTimeout(() => {
			if (!this.lobby) {
				ws.close(4000, STR_NO_LOBBY);
			}
		}, NO_LOBBY_TIMEOUT);
	}
}

class Lobby {
	constructor(name, host, mesh) {
		this.name = name;
		this.host = host;
		this.mesh = mesh;
		this.peers = [];
		this.sealed = false;
		this.closeTimer = -1;
		this.gameState = null; // Store current game state
	}

	getPeerId(peer) {
		if (this.host === peer.id) {
			return 1;
		}
		return peer.id;
	}

	join(peer) {
		const assigned = this.getPeerId(peer);
		peer.ws.send(ProtoMessage(CMD.ID, assigned, this.mesh ? 'true' : ''));
		this.peers.forEach((p) => {
			p.ws.send(ProtoMessage(CMD.PEER_CONNECT, assigned));
			peer.ws.send(ProtoMessage(CMD.PEER_CONNECT, this.getPeerId(p)));
		});
		this.peers.push(peer);
	}

	async leave(peer) {
		const idx = this.peers.findIndex((p) => peer === p);
		if (idx === -1) {
			return false;
		}
		const assigned = this.getPeerId(peer);
		const wasHost = assigned === 1;
		
		// Remove peer first
		this.peers.splice(idx, 1);
		
		if (wasHost) {
			// Host left - handle host migration or lobby closure
			if (this.peers.length === 0) {
				// No peers left - save game state to database
				if (this.gameState) {
					await gameStateDB.saveGame(this.name, this.gameState);
					console.log(`Saved game state for empty lobby ${this.name}`);
				}
				return true; // Close lobby
			} else {
				// Migrate host to first remaining peer
				const newHost = this.peers[0];
				this.host = newHost.id;
				
				// Notify new host
				newHost.ws.send(ProtoMessage(CMD.HOST_CHANGED, 1, STR_NEW_HOST));
				
				// Notify all other peers about host change
				this.peers.slice(1).forEach((p) => {
					p.ws.send(ProtoMessage(CMD.HOST_CHANGED, this.getPeerId(newHost), STR_HOST_CHANGED));
				});
				
				console.log(`Host migrated from ${peer.id} to ${newHost.id} in lobby ${this.name}`);
				
				// Don't close lobby
				return false;
			}
		} else {
			// Regular peer left - notify remaining peers
			this.peers.forEach((p) => {
				p.ws.send(ProtoMessage(CMD.PEER_DISCONNECT, assigned));
			});
			return false;
		}
	}

	seal(peer) {
		// Only host can seal
		if (peer.id !== this.host) {
			throw new ProtoError(4000, STR_ONLY_HOST_CAN_SEAL);
		}
		this.sealed = true;
		this.peers.forEach((p) => {
			p.ws.send(ProtoMessage(CMD.SEAL, 0));
		});
		console.log(`Peer ${peer.id} sealed lobby ${this.name} `
			+ `with ${this.peers.length} peers`);
		this.closeTimer = setTimeout(() => {
			// Close peer connection to host (and thus the lobby)
			this.peers.forEach((p) => {
				p.ws.close(1000, STR_SEAL_COMPLETE);
			});
		}, SEAL_CLOSE_TIMEOUT);
	}

	updateGameState(gameState) {
		this.gameState = gameState;
		console.log(`Updated game state for lobby ${this.name}`);
	}

	getHost() {
		return this.peers.find(p => p.id === this.host);
	}
}

const lobbies = new Map();
let peersCount = 0;

async function joinLobby(peer, pLobby, mesh) {
	let lobbyName = pLobby;
	let isRestoredGame = false;
	let savedGameState = null;
	
	if (lobbyName === '') {
		if (lobbies.size >= MAX_LOBBIES) {
			throw new ProtoError(4000, STR_TOO_MANY_LOBBIES);
		}
		// Peer must not already be in a lobby
		if (peer.lobby !== '') {
			throw new ProtoError(4000, STR_ALREADY_IN_LOBBY);
		}
		lobbyName = await codeGenerator.generateCode(); // randomSecret();
		console.log(`generated lobby name: ${lobbyName}`)
		lobbies.set(lobbyName, new Lobby(lobbyName, peer.id, mesh));
		console.log(`Peer ${peer.id} created lobby ${lobbyName}`);
		console.log(`Open lobbies: ${lobbies.size}`);
	} else {
		// Check if this is a saved game
		savedGameState = await gameStateDB.loadGame(lobbyName);
		if (savedGameState) {
			isRestoredGame = true;
			// Create new lobby with this peer as host
			if (peer.lobby !== '') {
				throw new ProtoError(4000, STR_ALREADY_IN_LOBBY);
			}
			const lobby = new Lobby(lobbyName, peer.id, mesh);
			lobby.gameState = savedGameState;
			lobbies.set(lobbyName, lobby);
			console.log(`Peer ${peer.id} restored lobby ${lobbyName} from saved game`);
		} else {
			// Try to join existing lobby
			const lobby = lobbies.get(lobbyName);
			if (!lobby) {
				throw new ProtoError(4000, STR_LOBBY_DOES_NOT_EXISTS);
			}
			if (lobby.sealed) {
				throw new ProtoError(4000, STR_LOBBY_IS_SEALED);
			}
		}
	}
	
	const lobby = lobbies.get(lobbyName);
	if (!lobby) {
		throw new ProtoError(4000, STR_SERVER_ERROR);
	}
	
	peer.lobby = lobbyName;
	console.log(`Peer ${peer.id} joining lobby ${lobbyName} `
		+ `with ${lobby.peers.length} peers`);
	lobby.join(peer);
	peer.ws.send(ProtoMessage(CMD.JOIN, 0, lobbyName));
	
	// If this is a restored game, send the game state to the new host
	if (isRestoredGame && savedGameState) {
		peer.ws.send(ProtoMessage(CMD.GAME_STATE, 0, JSON.stringify(savedGameState)));
		console.log(`Sent saved game state to new host ${peer.id}`);
	}
}

async function parseMsg(peer, msg) {
	let json = null;
	try {
		json = JSON.parse(msg);
	} catch (e) {
		throw new ProtoError(4000, STR_INVALID_FORMAT);
	}

	const type = typeof (json['type']) === 'number' ? Math.floor(json['type']) : -1;
	const id = typeof (json['id']) === 'number' ? Math.floor(json['id']) : -1;
	const data = typeof (json['data']) === 'string' ? json['data'] : '';

	if (type < 0 || id < 0) {
		throw new ProtoError(4000, STR_INVALID_FORMAT);
	}

	// Lobby joining.
	if (type === CMD.JOIN) {		
		await joinLobby(peer, data, id === 0);
		return;
	}

	if (!peer.lobby) {
		throw new ProtoError(4000, STR_NEED_LOBBY);
	}
	const lobby = lobbies.get(peer.lobby);
	if (!lobby) {
		throw new ProtoError(4000, STR_SERVER_ERROR);
	}

	// Game state saving (only host can save)
	if (type === CMD.SAVE_GAME) {
		if (peer.id !== lobby.host) {
			throw new ProtoError(4000, 'Only host can save game state');
		}
		try {
			const gameState = JSON.parse(data);
			lobby.updateGameState(gameState);
			peer.ws.send(ProtoMessage(CMD.SAVE_GAME, 0, 'Game state saved'));
		} catch (e) {
			throw new ProtoError(4000, 'Invalid game state format');
		}
		return;
	}

	// Lobby sealing.
	if (type === CMD.SEAL) {
		lobby.seal(peer);
		return;
	}

	// Message relaying format:
	//
	// {
	//   "type": CMD.[OFFER|ANSWER|CANDIDATE],
	//   "id": DEST_ID,
	//   "data": PAYLOAD
	// }
	if (type === CMD.OFFER || type === CMD.ANSWER || type === CMD.CANDIDATE) {
		let destId = id;
		if (id === 1) {
			destId = lobby.host;
		}
		const dest = lobby.peers.find((e) => e.id === destId);
		// Dest is not in this room.
		if (!dest) {
			throw new ProtoError(4000, STR_INVALID_DEST);
		}
		dest.ws.send(ProtoMessage(type, lobby.getPeerId(peer), data));
		return;
	}
	throw new ProtoError(4000, STR_INVALID_CMD);
}

wss.on('connection', (ws) => {
	if (peersCount >= MAX_PEERS) {
		ws.close(4000, STR_TOO_MANY_PEERS);
		return;
	}
	peersCount++;
	const id = randomId();
	const peer = new Peer(id, ws);
	ws.on('message', async (message) => {
		if (typeof message !== 'string') {
			ws.close(4000, STR_INVALID_TRANSFER_MODE);
			return;
		}
		try {
			await parseMsg(peer, message);
		} catch (e) {
			const code = e.code || 4000;
			console.log(`Error parsing message from ${id}:\n${message}`);
			ws.close(code, e.message);
		}
	});
	ws.on('close', async (code, reason) => {
		peersCount--;
		console.log(`Connection with peer ${peer.id} closed `
			+ `with reason ${code}: ${reason}`);
		if (peer.lobby && lobbies.has(peer.lobby)) {
			const shouldClose = await lobbies.get(peer.lobby).leave(peer);
			if (shouldClose) {
				lobbies.delete(peer.lobby);
				console.log(`Deleted lobby ${peer.lobby}`);
				console.log(`Open lobbies: ${lobbies.size}`);
			}
			peer.lobby = '';			
		}
		if (peer.timeout >= 0) {
			clearTimeout(peer.timeout);
			peer.timeout = -1;
		}
	});
	ws.on('error', (error) => {
		console.error(error);
	});
});

const interval = setInterval(() => {
	wss.clients.forEach((ws) => {
		ws.ping();
	});
}, PING_INTERVAL);