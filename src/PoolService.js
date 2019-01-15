const Nimiq = require('@nimiq/core');
const mysql = require('mysql2/promise');

const Helper = require('./Helper.js');

class PoolService extends Nimiq.Observable {
    /**
     * @param {Nimiq.BaseConsensus} consensus
     * @param {PoolConfig} config
     * @param {string} mySqlPsw
     * @param {string} mySqlHost
     */
    constructor(consensus, config, mySqlPsw, mySqlHost) {
        super();

        /** @type {Nimiq.BaseConsensus} */
        this._consensus = consensus;

        /** @type {Nimiq.Address} */
        this.poolAddress = Nimiq.Address.fromUserFriendlyAddress(config.address);

        /** @type {PoolConfig} */
        this._config = config;

        /** @type {string} */
        this._mySqlPsw = mySqlPsw;

        /** @type {string} */
        this._mySqlHost = mySqlHost;

        /** @type {Nimiq.Synchronizer} */
        this._synchronizer = new Nimiq.Synchronizer();
    }

    async start() {
        this.connectionPool = await mysql.createPool({
            host: this._mySqlHost,
            user: 'pool_service',
            password: this._mySqlPsw,
            database: 'pool'
        });

        this.consensus.blockchain.on('head-changed', (head) => this._synchronizer.push(async () => {
            await this._setBlockOnMainChain(head, head.height, true);
            await this._distributePayinsForBlock(head);
            this._removeOldDbEntries(head.height);
        }));
        this.consensus.blockchain.on('block-reverted', (head) => this._synchronizer.push(() => this._setBlockOnMainChain(head, head.height, false)));
    }

    /**
     * Reward type: Pay Per Last N Shares
     * @param {Nimiq.Block} block
     * @private
     */
    async _distributePayinsForBlock(block) {
        Nimiq.Log.d(PoolService, 'Miner addr ' + block.minerAddr.toUserFriendlyAddress() + ' our ' + this.poolAddress.toUserFriendlyAddress());
        if (block.minerAddr.equals(this.poolAddress)) {
            const blockId = await Helper.getStoreBlockId(this.connectionPool, block.hash(), block.height, block.timestamp);
            const [difficultyByUser, totalDifficulty] = await this._getLastNShares(block, this._config.pplnsBlocks);
            let payableBlockReward = Helper.getPayableBlockReward(this._config, block);
            Nimiq.Log.i(PoolService, `Distributing payable value of ${Nimiq.Policy.satoshisToCoins(payableBlockReward)} NIM to ${difficultyByUser.size} users`);
            for (const [userId, difficulty] of difficultyByUser) {
                const userReward = Math.floor(difficulty * payableBlockReward / totalDifficulty);
                await this._storePayin(userId, userReward, blockId);
            }
        }
    }

    /**
     * @param {Nimiq.Block} lastBlock
     * @param {number} n
     * @returns {[Map.<Nimiq.Address,number>, number]}
     * @private
     */
    async _getLastNShares(lastBlock, n) {
        const ret = new Map();
        const query = `
            SELECT user, SUM(difficulty) AS difficulty_sum
            FROM shares
            INNER JOIN block ON block.id = shares.prev_block
            WHERE block.main_chain = true AND block.height >= ? AND block.height <= ?
            GROUP BY user`;
        // Don't take shares onto the previous head into account because server instances haven't pushed all shares jet => -1
        const queryArgs = [lastBlock.height - n, lastBlock.height - 1];
        const [rows, fields] = await this.connectionPool.execute(query, queryArgs);

        let totalDifficulty = 0;
        for (const row of rows) {
            ret.set(row.user, row.difficulty_sum);
            totalDifficulty += row.difficulty_sum;
        }
        return [ret, totalDifficulty];
    }

    async _removeOldDbEntries(currHeight) {
        if (this._config.databaseRetentionBlocks == -1) return;
        let query = `
            DELETE shares
            FROM shares
            LEFT JOIN block on shares.prev_block=block.id
            WHERE block.height < ?
        `;
        let queryArgs = [currHeight - Math.max(this._config.payoutConfirmations, this._config.pplnsBlocks, this._config.databaseRetentionBlocks)];
        await this.connectionPool.execute(query, queryArgs);
    }

    /**
     * @param {Nimiq.Address} userId
     * @param {number} amount
     * @param {number} blockId
     * @private
     */
    async _storePayin(userId, amount, blockId) {
        const query = "INSERT INTO payin (user, amount, block) VALUES (?, ?, ?)";
        const queryArgs = [userId, amount, blockId];
        await this.connectionPool.execute(query, queryArgs);
    }

    /**
     * @param {Nimiq.Block} block
     * @param {number} height
     * @param {boolean} onMainChain
     * @private
     */
    async _setBlockOnMainChain(block, height, onMainChain) {
        const query = `
            INSERT INTO block (hash, height, datetime, main_chain) VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE main_chain=?`;
        const queryArgs = [ block.hash().serialize(), block.height, block.timestamp, onMainChain, onMainChain ];
        await this.connectionPool.execute(query, queryArgs);
    }

    /**
     * @type {Nimiq.BaseConsensus}
     * */
    get consensus() {
        return this._consensus;
    }
}

module.exports = exports = PoolService;
