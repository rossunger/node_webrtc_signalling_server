// Sequential Code Generator with Base-34 Encoding
// Replaces random code generation to avoid clashes while appearing random to users

class SequentialCodeGenerator {
    constructor() {
        // Base-34 alphabet (excludes 0, 1, I, O to avoid confusion)
        this.ALPHABET = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
        this.BASE = this.ALPHABET.length; // 32
        this.CODE_LENGTH = 6;
        
        // Persistent counter - in production, store this in your database
        this.counter = this.loadCounter();
        
        // Maximum number of codes possible with 4 characters in base-34
        this.MAX_CODES = Math.pow(this.BASE, this.CODE_LENGTH); // 1,336,336 possible codes
        
        console.log(`Sequential code generator initialized. Max codes: ${this.MAX_CODES.toLocaleString()}`);
    }

    // Load counter from persistent storage (database, file, etc.)
    loadCounter() {
        // In production, load from database:
        // return await db.collection('counters').findOne({name: 'lobby_codes'})?.value || 1;
        
        // For demo, start from a random offset to make codes appear more random
        return Math.floor(Math.random() * 10000) + 1;
    }

    // Save counter to persistent storage
    async saveCounter(counter) {
        // In production, save to database:
        // await db.collection('counters').updateOne(
        //     {name: 'lobby_codes'}, 
        //     {$set: {value: counter}}, 
        //     {upsert: true}
        // );
        
        this.counter = counter;
    }

    // Convert number to base-34 string
    encodeBase34(number) {
        if (number === 0) return this.ALPHABET[0].repeat(this.CODE_LENGTH);
        
        let result = '';
        let num = number;
        
        while (num > 0) {
            result = this.ALPHABET[num % this.BASE] + result;
            num = Math.floor(num / this.BASE);
        }
        
        // Pad with leading characters to maintain consistent length
        while (result.length < this.CODE_LENGTH) {
            result = this.ALPHABET[0] + result;
        }
        
        return result;
    }

    // Convert base-34 string back to number (for validation/debugging)
    decodeBase34(code) {
        let result = 0;
        for (let i = 0; i < code.length; i++) {
            const char = code[i];
            const value = this.ALPHABET.indexOf(char);
            if (value === -1) {
                throw new Error(`Invalid character in code: ${char}`);
            }
            result = result * this.BASE + value;
        }
        return result;
    }

    // Generate next sequential code
    async generateCode() {
        if (this.counter >= this.MAX_CODES) {
            // Counter overflow - reset or handle as needed
            console.warn('Code counter overflow, resetting to 1');
            this.counter = 1;
        }
        
        const code = this.encodeBase34(this.counter);
        this.counter++;
        
        // Save counter periodically or after each generation
        await this.saveCounter(this.counter);
        
        return code;
    }

    // Validate a code format
    isValidCode(code) {
        if (typeof code !== 'string' || code.length !== this.CODE_LENGTH) {
            return false;
        }
        
        for (let char of code) {
            if (this.ALPHABET.indexOf(char) === -1) {
                return false;
            }
        }
        
        return true;
    }

    // Get statistics about code generation
    getStats() {
        return {
            currentCounter: this.counter,
            codesGenerated: this.counter - 1,
            remainingCodes: this.MAX_CODES - this.counter,
            percentageUsed: ((this.counter - 1) / this.MAX_CODES * 100).toFixed(4),
            maxPossibleCodes: this.MAX_CODES
        };
    }

    // Reset counter (admin function)
    async resetCounter(startValue = 1) {
        this.counter = startValue;
        await this.saveCounter(this.counter);
        console.log(`Counter reset to ${startValue}`);
    }
}

// Enhanced version with better randomization
class EnhancedSequentialCodeGenerator extends SequentialCodeGenerator {
    constructor(seed = null) {
        super();
        
        // Use a simple reversible transformation to make sequential codes appear random
        // This is a basic Linear Congruential Generator for mixing
        this.multiplier = 1103515245;  // LCG multiplier
        this.increment = 12345;        // LCG increment
        this.modulus = this.MAX_CODES; // Use max codes as modulus
        
        // Optional seed for deterministic "randomness"
        this.seed = seed || Math.floor(Math.random() * 1000000);
        console.log(`Enhanced generator initialized with seed: ${this.seed}`);
    }

    // Apply reversible transformation to make sequential numbers appear random
    transformNumber(sequential) {
        // Simple mixing function - makes sequential numbers appear random
        // while still being reversible and collision-free
        return ((sequential * this.multiplier + this.increment + this.seed) % this.modulus);
    }

    // Reverse the transformation (for debugging/validation)
    reverseTransform(transformed) {
        // Calculate modular multiplicative inverse (simplified for this example)
        // In production, use proper modular inverse calculation
        let inverse = 1;
        for (let i = 1; i < this.modulus; i++) {
            if ((this.multiplier * i) % this.modulus === 1) {
                inverse = i;
                break;
            }
        }
        return ((transformed - this.increment - this.seed) * inverse) % this.modulus;
    }

    // Generate code with randomization
    async generateCode() {
        if (this.counter >= this.MAX_CODES) {
            console.warn('Code counter overflow, resetting to 1');
            this.counter = 1;
        }
        
        const sequential = this.counter;
        const transformed = this.transformNumber(sequential);
        const code = this.encodeBase34(transformed);
        
        this.counter++;
        await this.saveCounter(this.counter);
        
        return code;
    }
}

// Database-backed version for production
class DatabaseSequentialCodeGenerator extends EnhancedSequentialCodeGenerator {
    constructor(database, seed = null) {
        super(seed);
        this.db = database;
    }

    async loadCounter() {
        try {
            const result = await this.db.collection('counters').findOne({name: 'lobby_codes'});
            return result ? result.value : 1;
        } catch (error) {
            console.error('Error loading counter from database:', error);
            return 1;
        }
    }

    async saveCounter(counter) {
        try {
            await this.db.collection('counters').updateOne(
                {name: 'lobby_codes'}, 
                {$set: {value: counter, lastUpdated: new Date()}}, 
                {upsert: true}
            );
            this.counter = counter;
        } catch (error) {
            console.error('Error saving counter to database:', error);
        }
    }
}

// Export for use in your WebSocket server
module.exports = {
    SequentialCodeGenerator,
    EnhancedSequentialCodeGenerator,
    DatabaseSequentialCodeGenerator
};

// Example usage:
/*
const { EnhancedSequentialCodeGenerator } = require('./sequential-code-generator');

// In your WebSocket server initialization:
const codeGenerator = new EnhancedSequentialCodeGenerator();

// Replace the randomSecret function:
function generateLobbyCode() {
    return codeGenerator.generateCode();  // No await needed!
}

// Usage in joinLobby function:
if (lobbyName === '') {
    if (lobbies.size >= MAX_LOBBIES) {
        throw new ProtoError(4000, STR_TOO_MANY_LOBBIES);
    }
    if (peer.lobby !== '') {
        throw new ProtoError(4000, STR_ALREADY_IN_LOBBY);
    }
    
    lobbyName = await generateLobbyCode(); // Instead of randomSecret()
    lobbies.set(lobbyName, new Lobby(lobbyName, peer.id, mesh));
    console.log(`Peer ${peer.id} created lobby ${lobbyName}`);
    console.log(`Open lobbies: ${lobbies.size}`);
}
*/

// Demo/Test function
async function demonstrateCodeGeneration() {
    console.log('\n=== Demonstrating Sequential Code Generation ===');
    
    const basicGenerator = new SequentialCodeGenerator();
    const enhancedGenerator = new EnhancedSequentialCodeGenerator(12345);
    
    console.log('\nBasic Sequential Codes:');
    for (let i = 0; i < 10; i++) {
        const code = await basicGenerator.generateCode();
        console.log(`${i + 1}: ${code} (decoded: ${basicGenerator.decodeBase34(code)})`);
    }
    
    console.log('\nEnhanced Sequential Codes (appear random):');
    for (let i = 0; i < 10; i++) {
        const code = await enhancedGenerator.generateCode();
        console.log(`${i + 1}: ${code}`);
    }
    
    console.log('\nGenerator Statistics:');
    console.log(enhancedGenerator.getStats());
    
    // Demonstrate collision-free nature
    console.log('\n=== Collision Test ===');
    const testGenerator = new EnhancedSequentialCodeGenerator(99999);
    const generatedCodes = new Set();
    let collisions = 0;
    
    for (let i = 0; i < 1000; i++) {
        const code = await testGenerator.generateCode();
        if (generatedCodes.has(code)) {
            collisions++;
        }
        generatedCodes.add(code);
    }
    
    console.log(`Generated 1000 codes, collisions: ${collisions}`);
    console.log(`Unique codes: ${generatedCodes.size}`);
}

// Uncomment to run demonstration
// demonstrateCodeGeneration();