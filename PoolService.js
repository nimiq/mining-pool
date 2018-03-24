const Nimiq = require('../core/dist/node.js');
const mysql = require('mysql2/promise');

const PoolConfig = require('./PoolConfig.js');
const Helper = require('./Helper.js');

class PoolService extends Nimiq.Observable {
    /**
     * @param {Nimiq.FullConsensus} consensus
     * @param {Nimiq.Address} poolAddress
     * @param {string} mySqlPsw
     */
    constructor(consensus, poolAddress, mySqlPsw) {
        super();
        this._consensus = consensus;
        this.poolAddress = poolAddress;
        this.mySqlPsw = mySqlPsw;

        /** @type {Map.<number, PoolAgent>} */
        this._agents = new Map();
    }

    async start() {
        this.connection = await mysql.createConnection({
            host: 'localhost',
            user: 'nimpool_service',
            password: this.mySqlPsw,
            database: 'nimpool'
        });

        this._consensus.blockchain.on('head-changed', (head) => this._distributePayinsForBlock(head));
        this._consensus.blockchain.on('block-reverted', (head) => this._removePayinsForBlock(head));
    }

    /**
     * Reward type: Pay Per Last N Shares
     * @param {Nimiq.Block} lastBlock
     * @private
     */
    async _distributePayinsForBlock(lastBlock) {
        console.log('miner addr ' + lastBlock.minerAddr.toUserFriendlyAddress() + ' our ' + this.poolAddress.toUserFriendlyAddress());
        if (lastBlock.minerAddr.equals(this.poolAddress)) {
            const blockId = await this._getStoreBlockId(lastBlock.hash(), lastBlock.height);
            const [addrDifficultySum, totalDifficultySum] = await this._summarizeShareDifficultiesPerUser(lastBlock);
            let totalBlockReward = (1 - PoolConfig.POOL_FEE) * (Nimiq.Policy.blockRewardAt(lastBlock.height) + lastBlock.transactions.reduce((sum, tx) => sum + tx.fee, 0));
            for (const addr of addrDifficultySum.keys()) {
                const userReward = addrDifficultySum.get(addr) * totalBlockReward / totalDifficultySum;
                await this._storePayin(addr, userReward, Date.now(), blockId);
            }
        }
    }

    /**
     *
     * @param {Nimiq.Block} lastBlock
     * @returns {[Map.<Nimiq.Address,number>, number]}
     * @private
     */
    async _summarizeShareDifficultiesPerUser(lastBlock) {
        const addrDifficultySum = new Map();
        let totalDifficultySum = 0;

        let backUntilBlock = await this.consensus.blockchain.getBlock(lastBlock.prevHash);
        while (backUntilBlock !== null && totalDifficultySum < lastBlock.difficulty) {
            let prevHashes = [];
            for (let i = 0; backUntilBlock !== null && i < 50; i++) {
                let hash = backUntilBlock.hash();
                prevHashes.push(hash);
                backUntilBlock = await this.consensus.blockchain.getBlock(backUntilBlock.prevHash);
            }
            const addrDifficulty = await this._getLastXDifficulty(prevHashes, lastBlock.difficulty);
            let totalDifficulty = 0;
            for (const userAddress of addrDifficulty.keys()) {
                totalDifficulty += addrDifficulty.get(userAddress);
                if (addrDifficultySum.has(userAddress)) {
                    addrDifficultySum.set(userAddress, addrDifficultySum.get(userAddress) + addrDifficulty.get(userAddress));
                } else {
                    addrDifficultySum.set(userAddress, addrDifficulty.get(userAddress));
                }
            }
            totalDifficultySum += totalDifficulty;
        }
        return [addrDifficultySum, totalDifficultySum];
    }

    /**
     * @param {Array.<Nimiq.Hash>} prevHashes
     * @param {number} difficulty
     * @returns {Promise.<Map.<Nimiq.Address,number>>}
     */
    async _getLastXDifficulty(prevHashes, difficulty) {
        const ret = new Map();

        let hashIds = await this._getBlockIds(prevHashes);
        if (hashIds.length === 0) return ret;
        const query = `
            SELECT last_x.user, SUM(last_x.difficulty) AS sum
            FROM (
                SELECT NULL AS user, NULL AS difficulty, NULL AS total
                FROM dual
                WHERE (@total := 0)
                
                UNION
                
                SELECT user, difficulty, @total := @total + difficulty AS total
                FROM share
                WHERE @total < ? AND prev_block IN (` + Array(hashIds.length).fill('?').join(', ') + `)
            ) AS last_x
            GROUP BY user
            `;
        const queryArgs = [difficulty, ...hashIds];
        const [rows, fields] = await this.connection.execute(query, queryArgs);

        for (let row of rows) {
            const address = await Helper.getUser(this.connection, row.user);
            ret.set(address, row.sum);
        }
        return ret;
    }

    /**
     * @param {Nimiq.Address} userAddress
     * @param {number} amount
     * @param {number} datetime
     * @param {Nimiq.Block} blockId
     * @private
     */
    async _storePayin(userAddress, amount, datetime, blockId) {
        const userId = await Helper.getUserId(this.connection, userAddress);

        const query = "INSERT INTO payin (user, amount, datetime, block) VALUES (?, ?, ?, ?)";
        const queryArgs = [userId, amount, datetime, blockId];
        await this.connection.execute(query, queryArgs);
    }

    /**
     *
     * @param {Nimiq.Hash} blockHash
     * @param {number} height
     * @returns {Promise<number>}
     * @private
     */
    async _getStoreBlockId(blockHash, height) {
        await this.connection.execute("INSERT IGNORE INTO block (hash, height) VALUES (?, ?)", [blockHash.serialize(), height]);
        return await this._getBlockId(blockHash);
    }

    /**
     * @param {Nimiq.Hash} blockHash
     * @returns {Promise<number>}
     * @private
     */
    async _getBlockId(blockHash) {
        const [rows, fields] = await this.connection.execute("SELECT id FROM block WHERE hash=?", [blockHash.serialize()]);
        if (rows.length > 0) {
            return rows[0].id;
        } else {
            return -1;
        }
    }

    /**
     * @param {Array.<Nimiq.Hash>} blockHashes
     * @returns {Promise<Array.<number>>}
     * @private
     */
    async _getBlockIds(blockHashes) {
        const query = "SELECT id FROM block WHERE hash IN (" + Array(blockHashes.length).fill('?') + ")";
        const queryArgs = [...blockHashes.map(h => h.serialize())];
        const [rows, fields] = await this.connection.execute(query, queryArgs);

        let ids = [];
        for (let row of rows) {
            ids.push(row.id);
        }
        return ids;
    }

    /**
     * @param {Nimiq.Block} latestBlock
     * @private
     */
    async _removePayinsForBlock(latestBlock) {
        const query = `
            DELETE FROM payin
            WHERE block=?`;
        const queryArgs = [ latestBlock.hash().serialize() ];
        await this.connection.execute(query, queryArgs);
    }

    /** @type {Nimiq.FullConsensus} */
    get consensus() {
        return this._consensus;
    }
}

module.exports = exports = PoolService;
