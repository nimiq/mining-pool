const Nimiq = require('../core/dist/node.js');
const PoolConfig = require('./PoolConfig.js');

class Helper {
    /**
     * @param {mysql2.Connection}  connection
     * @param {number} userId
     * @param {number} currChainHeight
     * @param {boolean} includeVirtual
     * @returns {Promise.<number>}
     */
    static async getUserBalance(connection, userId, currChainHeight, includeVirtual = false) {
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
        const [rows, fields] = await connection.execute(query, queryArgs);
        if (rows.length === 1) {
            return rows[0].balance;
        }
        return 0;
    }

    /**
     * @param {mysql2.Connection} connection
     * @param id
     * @returns {Promise.<Nimiq.Address>}
     */
    static async getUser(connection, id) {
        const [rows, fields] = await connection.execute("SELECT address FROM user WHERE id=?", [id]);
        return Nimiq.Address.fromBase64(rows[0].address);
    }

    /**
     * @param {mysql2.Connection}  connection
     * @param {Nimiq.Address} address
     * @returns {Promise.<number>}
     */
    static async getUserId(connection, address) {
        const [rows, fields] = await connection.execute("SELECT id FROM user WHERE address=?", [address.toBase64()]);
        return rows[0].id;
    }

    /**
     * @param {mysql2.Connection}  connection
     * @param {Nimiq.Hash} blockHash
     * @param {number} height
     * @returns {Promise.<number>}
     */
    static async getStoreBlockId(connection, blockHash, height) {
        await connection.execute("INSERT IGNORE INTO block (hash, height) VALUES (?, ?)", [blockHash.serialize(), height]);
        return await Helper.getBlockId(connection, blockHash);
    }

    /**
     * @param {mysql2.Connection}  connection
     * @param {Nimiq.Hash} blockHash
     * @returns {Promise.<number>}
     */
    static async getBlockId(connection, blockHash) {
        const [rows, fields] = await connection.execute("SELECT id FROM block WHERE hash=?", [blockHash.serialize()]);
        if (rows.length > 0) {
            return rows[0].id;
        } else {
            return -1;
        }
    }
}

module.exports = exports = Helper;
