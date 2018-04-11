const Nimiq = require('../core/dist/node.js');
const mysql = require('mysql2/promise');

const PoolConfig = require('./PoolConfig.js');
const Helper = require('./Helper.js');

class PoolService extends Nimiq.Observable {
    /**
     * @param {Nimiq.BaseConsensus} consensus
     * @param {Nimiq.Address} poolAddress
     * @param {string} mySqlPsw
     * @param {string} mySqlHost
     */
    constructor(consensus, poolAddress, mySqlPsw, mySqlHost) {
        super();

        /** @type {Nimiq.BaseConsensus} */
        this._consensus = consensus;

        /** @type {Nimiq.Address} */
        this.poolAddress = poolAddress;

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
            user: 'nimpool_service',
            password: this._mySqlPsw,
            database: 'nimpool'
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
        console.log('_miner addr ' + block.minerAddr.toUserFriendlyAddress() + ' our ' + this.poolAddress.toUserFriendlyAddress());
        if (block.minerAddr.equals(this.poolAddress)) {
            const blockId = await Helper.getStoreBlockId(this.connectionPool, block.hash(), block.height);
            const [addrDifficulty, totalDifficulty] = await this._getLastNShares(block, 1000);
            let totalBlockReward = Helper.getTotalBlockReward(block);
            for (const addr of addrDifficulty.keys()) {
                const userReward = Math.floor(addrDifficulty.get(addr) * totalBlockReward / totalDifficulty);
                await this._storePayin(addr, userReward, Date.now(), blockId);
            }
        }
    }

    /**
     * @param {Array.<Nimiq.Hash>} prevHashes
     * @param {number} n
     * @returns {Promise.<Map.<Nimiq.Address,number>>}
     */
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
                SELECT *
                FROM
                (
                    (
                        SELECT user, difficulty, prev_block from share
                    ) t1
                    INNER JOIN
                    (
                        SELECT * from block
                        WHERE main_chain=true AND height<=?
                    ) t2
                    ON t1.prev_block=t2.id
                )
                ORDER BY height DESC
                LIMIT ?
            ) t3
            GROUP BY user
            `;
        const queryArgs = [lastBlock.height, n];
        const [rows, fields] = await this.connectionPool.execute(query, queryArgs);

        let totalDifficulty = 0;
        for (let row of rows) {
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
     * @param {Nimiq.Block} blockId
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
