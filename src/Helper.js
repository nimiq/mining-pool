const Nimiq = require('@nimiq/core');

class Helper {

    /**
     * @param {PoolConfig} config
     * @param {Nimiq.Block} block
     * @returns {number}
     */
    static getPayableBlockReward(config, block) {
        return (1 - config.poolFee) * (Nimiq.Policy.blockRewardAt(block.height) + block.transactions.reduce((sum, tx) => sum + tx.fee, 0));
    }

    /**
     * @param {PoolConfig} config
     * @param {mysql2.Pool} connectionPool
     * @param {number} userId
     * @param {number} currChainHeight
     * @param {boolean} includeVirtual
     * @returns {Promise.<number>}
     */
    static async getUserBalance(config, connectionPool, userId, currChainHeight, includeVirtual = false) {
        const query = `
            SELECT IFNULL(payin_sum, 0) - IFNULL(payout_sum, 0) AS balance
            FROM (
                (
                    SELECT user, SUM(amount) AS payin_sum
                    FROM payin p
                    INNER JOIN block b ON b.id = p.block
                    WHERE p.user = ? AND b.main_chain = true AND b.height <= ?
                ) t1
                LEFT JOIN
                (
                    SELECT user, SUM(amount) AS payout_sum
                    FROM payout
                    WHERE user = ?
                ) t2
                ON t2.user = t1.user
            )`;
        const queryHeight = includeVirtual ? currChainHeight : currChainHeight - config.payoutConfirmations;
        const queryArgs = [userId, queryHeight, userId];
        const [rows, fields] = await connectionPool.execute(query, queryArgs);
        if (rows.length === 1) {
            return rows[0].balance;
        }
        return 0;
    }

    /**
     * @param {mysql2.Pool} connectionPool
     * @param id
     * @returns {Promise.<Nimiq.Address>}
     */
    static async getUser(connectionPool, id) {
        const [rows, fields] = await connectionPool.execute("SELECT address FROM user WHERE id=?", [id]);
        return Nimiq.Address.fromBase64(rows[0].address);
    }

    /**
     * @param {mysql2.Pool} connectionPool
     * @param {Nimiq.Address} address
     * @returns {Promise.<number>}
     */
    static async getUserId(connectionPool, address) {
        const [rows, fields] = await connectionPool.execute("SELECT id FROM user WHERE address=?", [address.toBase64()]);
        return rows[0].id;
    }

    /**
     * @param {mysql2.Pool} connectionPool
     * @param {Nimiq.Hash} blockHash
     * @param {number} height
     * @returns {Promise.<number>}
     */
    static async getStoreBlockId(connectionPool, blockHash, height) {
        await connectionPool.execute("INSERT IGNORE INTO block (hash, height) VALUES (?, ?)", [blockHash.serialize(), height]);
        return await Helper.getBlockId(connectionPool, blockHash);
    }

    /**
     * @param {mysql2.Pool}  connectionPool
     * @param {Nimiq.Hash} blockHash
     * @returns {Promise.<number>}
     */
    static async getBlockId(connectionPool, blockHash) {
        const [rows, fields] = await connectionPool.execute("SELECT id FROM block WHERE hash=?", [blockHash.serialize()]);
        if (rows.length > 0) {
            return rows[0].id;
        } else {
            return -1;
        }
    }

    /**
     * @returns {Promise.<number>}
     */
    static async getTotalBlocksMined(connectionPool) {
        const query = `
            SELECT COUNT(DISTINCT payin.block) AS blockcount FROM payin
            INNER JOIN block ON block.id = payin.block
            WHERE block.main_chain = 1
        `;
        const [rows, fields] = await connectionPool.execute(query);
        return rows[0].blockcount;
    }
}

module.exports = exports = Helper;
