const Nimiq = require('../core/dist/node.js');
const PoolConfig = require('./PoolConfig.js');

class Helper {
    /**
     * @param {mysql2.Pool} connectionPool
     * @param {number} userId
     * @param {number} currChainHeight
     * @param {boolean} includeVirtual
     * @returns {Promise.<number>}
     */
    static async getUserBalance(connectionPool, userId, currChainHeight, includeVirtual = false) {
        const query = `
        SELECT t1.user AS user, IFNULL(payin_sum, 0) - IFNULL(payout_sum, 0) AS balance
        FROM (
            (
                SELECT user, SUM(amount) AS payin_sum
                FROM (
                    (
                        SELECT user, block, amount
                        FROM payin
                        WHERE user=?
                    ) t3
                    INNER JOIN
                    (
                        SELECT id, height
                        FROM block
                        WHERE height <= ?
                    ) t4
                    
                    ON t4.id = t3.block
                )
                
            ) t1
            LEFT JOIN 
            (
                SELECT user, SUM(amount) as payout_sum
                FROM payout
                WHERE user=?
            ) t2
            ON t1.user = t2.user
        )
        `;
        const queryHeight = includeVirtual ? currChainHeight : currChainHeight - PoolConfig.CONFIRMATIONS;
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
}

module.exports = exports = Helper;
