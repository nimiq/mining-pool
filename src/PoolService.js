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

        this.consensus.blockchain.on('head-changed', (head) => this._distributePayinsForBlock(head));
        this.consensus.blockchain.on('head-changed', (head) => this._synchronizer.push(() => this._setBlockOnMainChain(head, head.height, true)));
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
            const blockId = await Helper.getStoreBlockId(this.connectionPool, block.hash(), block.height);
            const [difficultyByAddress, totalDifficulty] = await this._getLastNShares(block, this._config.pplnsShares);
            const blockReward = Helper.getBlockReward(block);
            const customPoolFees = await Helper.getCustomPoolFees(this.connectionPool);
            let totalPayout = 0;
            Nimiq.Log.i(PoolService, `Distributing payments of ${Nimiq.Policy.satoshisToCoins(blockReward)} NIM to ${difficultyByAddress.size} users...`);
            for (const [addr, difficulty] of difficultyByAddress) {
                const address = addr.toString();
                const fee = customPoolFees.has(address)
                  ? customPoolFees.get(address)
                  : this._config.poolFee;
                const userReward = (1 - fee) * Math.floor(difficulty * blockReward / totalDifficulty);
                await this._storePayin(addr, userReward, Date.now(), blockId);
                totalPayout += userReward;
            }

            const query = `INSERT INTO payin_total (block_height, amount) VALUES (?, ?)`;
            await connectionPool.execute(query, [block.height || block.height(), totalPayout]);

            Nimiq.Log.i(PoolService, `Distributed payable value of ${Nimiq.Policy.satoshisToCoins(totalPayout)} NIM.`);
            Nimiq.Log.i(PoolService, `Collected ${Nimiq.Policy.satoshisToCoins(blockReward - totalPayout)} NIM in fees.`);
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
            FROM
            (
                SELECT user, difficulty
                FROM share
                INNER JOIN block ON block.id = share.prev_block
                WHERE block.main_chain = true AND block.height <= ?
                ORDER BY block.height DESC
                LIMIT ?
            ) t1
            GROUP BY user`;
        const queryArgs = [lastBlock.height, n];
        const [rows, fields] = await this.connectionPool.execute(query, queryArgs);

        let totalDifficulty = 0;
        for (const row of rows) {
            const address = await Helper.getUser(this.connectionPool, row.user);
            ret.set(address, row.difficulty_sum);
            totalDifficulty += row.difficulty_sum;
        }
        return [ret, totalDifficulty];
    }

    /**
     * @param {Nimiq.Address} userAddress
     * @param {number} amount
     * @param {number} datetime
     * @param {number} blockId
     * @private
     */
    async _storePayin(userAddress, amount, datetime, blockId) {
        const userId = await Helper.getUserId(this.connectionPool, userAddress);

        const query = "INSERT INTO payin (user, amount, datetime, block) VALUES (?, ?, ?, ?)";
        const queryArgs = [userId, amount, datetime, blockId];
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
            INSERT INTO block (hash, height, main_chain) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE main_chain=?`;
        const queryArgs = [ block.hash().serialize(), block.height, onMainChain, onMainChain ];
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
