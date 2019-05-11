const https = require('https');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const fs = require('fs');

const Nimiq = require('@nimiq/core');
const JungleDb = require('@nimiq/jungle-db');

const PoolAgent = require('./PoolAgent.js');
const Helper = require('./Helper.js');

class PoolServer extends Nimiq.Observable {
    /**
     * @param {Nimiq.FullConsensus} consensus
     * @param {PoolConfig} config
     * @param {number} port
     * @param {string} mySqlPsw
     * @param {string} mySqlHost
     * @param {string} sslKeyPath
     * @param {string} sslCertPath
     * @param {{enabled: boolean, port: number, address: string, addresses: Array.<string>, header: string, checkSource: boolean, acceptHeader: boolean}} reverseProxy
     */
    constructor(consensus, config, port, mySqlPsw, mySqlHost, sslKeyPath, sslCertPath, reverseProxy) {
        super();

        /** @type {Nimiq.FullConsensus} */
        this._consensus = consensus;

        /** @type {string} */
        this.name = config.name;

        /** @type {Nimiq.Address} */
        this.poolAddress = Nimiq.Address.fromUserFriendlyAddress(config.address);

        /** @type {PoolConfig} */
        this._config = config;

        /** @type {number} */
        this.port = port;

        /** @type {string} */
        this._mySqlPsw = mySqlPsw;

        /** @type {string} */
        this._mySqlHost = mySqlHost;

        /** @type {string} */
        this._sslKeyPath = sslKeyPath;

        /** @type {string} */
        this._sslCertPath = sslCertPath;

        /** @type {{enabled: boolean, port: number, address: string, addresses: Array.<string>, header: string, checkSource: boolean, acceptHeader: boolean}} */
        this._reverseProxy = reverseProxy;

        /** @type {Nimiq.Miner} */
        this._miner = new Nimiq.Miner(consensus.blockchain, consensus.blockchain.accounts, consensus.mempool, consensus.network.time, this.poolAddress);

        /** @type {Set.<PoolAgent>} */
        this._agents = new Set();

        /** @type {Nimiq.HashMap.<number, Array.<Hash>>} */
        this._shares = new Nimiq.HashMap();

        /** @type {HashMap.<string, {userId: Address, deviceId: number, prevBlockId: number, difficulty: BigNumber, count: number}>} */
        this._shareSummary = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Nimiq.NetAddress, number>} */
        this._connectionsInTimePerIPv4 = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Uint8Array, number>} */
        this._connectionsInTimePerIPv6 = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Nimiq.NetAddress, number>} */
        this._connectionsPerIPv4 = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Uint8Array, number>} */
        this._connectionsPerIPv6 = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Nimiq.NetAddress, number>} */
        this._bannedIPv4IPs = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Uint8Array, number>} */
        this._bannedIPv6IPs = new Nimiq.HashMap();

        /** @type {number} */
        this._numBlocksMined = 0;

        /** @type {Nimiq.BigNumber} */
        this._totalShareDifficulty = new Nimiq.BigNumber(0);

        /** @type {number} */
        this._lastShareDifficulty = 0;

        /** @type {number[]} */
        this._hashrates = [];

        /** @type {number} */
        this._averageHashrate = 0;

        /** @type {boolean} */
        this._started = false;

        /** @type {JungleDb.LRUMap} */
        this._userAddressToId = new JungleDb.LRUMap(200);

        /** @type {JungleDb.LRUMap} */
        this._blockHashToId = new JungleDb.LRUMap(10);

        setInterval(() => {
            this._connectionsInTimePerIPv4 = new Nimiq.HashMap();
            this._connectionsInTimePerIPv6 = new Nimiq.HashMap();
        }, this.config.maxConnTimeUnit);

        setInterval(() => this._checkUnbanIps(), PoolServer.UNBAN_IPS_INTERVAL);

        setInterval(() => this._calculateHashrate(), PoolServer.HASHRATE_INTERVAL);

        setInterval(() => this._flushSharesToDb(), this._config.flushSharesInterval);

        this.consensus.on('established', () => this.start());
    }

    async start() {
        if (this._started) return;
        this._started = true;

        this._currentLightHead = this.consensus.blockchain.head.toLight();
        await this._updateTransactions();

        this.connectionPool = await mysql.createPool({
            host: this._mySqlHost,
            user: 'pool_server',
            password: this._mySqlPsw,
            database: 'pool'
        });

        this._wss = PoolServer.createServer(this.port, this._sslKeyPath, this._sslCertPath);
        this._wss.on('connection', (ws, req) => this._onConnection(ws, req));

        this.consensus.blockchain.on('head-changed', (head) => {
            this._announceHeadToNano(head);
            this._flushSharesToDb();
            this._removeOldShares(head.header.prevHash);
        });
    }

    static createServer(port, sslKeyPath, sslCertPath) {
        const sslOptions = {
            key: fs.readFileSync(sslKeyPath),
            cert: fs.readFileSync(sslCertPath)
        };
        const httpsServer = https.createServer(sslOptions, (req, res) => {
            res.writeHead(200);
            res.end('Nimiq Pool Server\n');
        }).listen(port);

        // We have to access socket.remoteAddress here because otherwise req.connection.remoteAddress won't be set in the WebSocket's 'connection' event (yay)
        httpsServer.on('secureConnection', socket => socket.remoteAddress);

        Nimiq.Log.i(PoolServer, "Started server on port " + port);
        return new WebSocket.Server({server: httpsServer});
    }

    stop() {
        if (this._wss) {
            this._wss.close();
        }
    }

    /**
     * @param {WebSocket} ws
     * @param {http.IncomingMessage} req
     * @private
     */
    _onConnection(ws, req) {
        try {
            let netAddress = Nimiq.NetAddress.fromIP(req.connection.remoteAddress);
            if (this._reverseProxy.enabled || this._reverseProxy.checkSource) {
                let addresses = this._reverseProxy.addresses;
                if (!addresses) addresses = [this._reverseProxy.address];
                let matches = false;
                for (const address of addresses) {
                    let [ip, mask] = address.split('/');
                    if (mask) {
                        matches = Nimiq.NetAddress.fromIP(ip).subnet(mask).equals(netAddress.subnet(mask))
                    } else {
                        matches = Nimiq.NetAddress.fromIP(ip).equals(netAddress);
                    }
                    if (matches) break;
                }
                if (!matches) {
                    Nimiq.Log.e(PoolServer, `Received connection from ${netAddress.toString()} when all connections were expected from the reverse proxy: closing the connection`);
                    ws.close();
                    return;
                }
            }
            if (this._reverseProxy.enabled || this._reverseProxy.acceptHeader) {
                const reverseProxyHeader = this._reverseProxy.header;
                if (req.headers[reverseProxyHeader]) {
                    netAddress = Nimiq.NetAddress.fromIP(req.headers[reverseProxyHeader].split(/\s*,\s*/)[0]);
                } else if (this._reverseProxy.enabled) {
                    Nimiq.Log.i(PoolServer, `Expected header '${reverseProxyHeader}' to contain the real IP from the connecting client: closing the connection`);
                    ws.close();
                    return;
                } else {
                    Nimiq.Log.w(PoolServer, `Expected header '${reverseProxyHeader}' to contain the real IP from the connecting client`);
                }
            }
            if (this._isIpBanned(netAddress)) {
                Nimiq.Log.i(PoolServer, `[${netAddress}] Banned IP tried to connect`);
                ws.close();
            } else if (this._newIpConnTooMany(netAddress))  {
                Nimiq.Log.i(PoolServer, `[${netAddress}] Rejecting connection from IP having established too many connections (lately)`);
                ws.send(JSON.stringify({ message: PoolAgent.MESSAGE_ERROR, reason: 'too many consecutive or total connections per IP' }));
                ws.close();
            } else {
                const agent = new PoolAgent(this, ws, netAddress);
                agent.on('share', (header, difficulty) => this._onShare(header, difficulty));
                agent.on('block', (header) => this._onBlock(header));
                this._agents.add(agent);
            }
        } catch (e) {
            Nimiq.Log.e(PoolServer, e);
            ws.close();
        }
    }

    /**
     * @param {BlockHeader} header
     * @param {BigNumber} difficulty
     * @private
     */
    _onShare(header, difficulty) {
        this._totalShareDifficulty = this._totalShareDifficulty.plus(difficulty);
    }

    /**
     * @param {BlockHeader} header
     * @private
     */
    _onBlock(header) {
        this._numBlocksMined++;
    }

    /**
     * @param {PoolAgent} agent
     */
    requestCurrentHead(agent) {
        agent.updateBlock(this._currentLightHead, this._block);
    }

    /**
     * @param {Block} head
     * @private
     */
    async _announceHeadToNano(head) {
        this._currentLightHead = head.toLight();
        await this._updateTransactions();
    }

    async _updateTransactions() {
        try {
            this._block = await this._miner.getNextBlock();
            this._nextTransactions = this._block.body.transactions;
            this._nextPrunedAccounts = this._block.body.prunedAccounts;
            this._nextAccountsHash = this._block.header._accountsHash;
            this._nextBlockHeader = this._block.header;
            this._announceNewNextToNano();
        } catch(e) {
            setTimeout(() => this._updateTransactions(), 100);
        }
    }

    _announceNewNextToNano() {
        for (const poolAgent of this._agents.values()) {
            if (poolAgent.mode === PoolAgent.Mode.NANO || poolAgent.mode === PoolAgent.Mode.DUMB) {
                poolAgent.updateBlock(this._currentLightHead, this._block);
            }
        }
    }

    /**
     * @param {NetAddress} netAddress
     */
    banIp(netAddress) {
        if (!netAddress.isPrivate()) {
            Nimiq.Log.i(PoolServer, `Banning IP ${netAddress}`);
            if (netAddress.isIPv4()) {
                this._bannedIPv4IPs.put(netAddress, Date.now() + PoolServer.DEFAULT_BAN_TIME);
            } else if (netAddress.isIPv6()) {
                // Ban IPv6 IPs prefix based
                this._bannedIPv6IPs.put(netAddress.ip.subarray(0,8), Date.now() + PoolServer.DEFAULT_BAN_TIME);
            }
        }
    }

    /**
     * @param {NetAddress} netAddress
     * @returns {boolean}
     * @private
     */
    _isIpBanned(netAddress) {
        if (this._config.banned.includes(netAddress.toString())) return true;
        if (netAddress.isPrivate()) return false;
        if (netAddress.isIPv4()) {
            return this._bannedIPv4IPs.contains(netAddress);
        } else if (netAddress.isIPv6()) {
            const prefix = netAddress.ip.subarray(0, 8);
            return this._bannedIPv6IPs.contains(prefix);
        }
        return false;
    }

    _checkUnbanIps() {
        const now = Date.now();
        for (const netAddress of this._bannedIPv4IPs.keys()) {
            if (this._bannedIPv4IPs.get(netAddress) < now) {
                this._bannedIPv4IPs.remove(netAddress);
            }
        }
        for (const prefix of this._bannedIPv6IPs.keys()) {
            if (this._bannedIPv6IPs.get(prefix) < now) {
                this._bannedIPv6IPs.remove(prefix);
            }
        }
    }

    /**
     * @param {NetAddress} netAddress
     * @returns {boolean}
     * @private
     */
    _newIpConnTooMany(netAddress) {
        if (!netAddress.isPrivate()) {
            if (netAddress.isIPv4()) {
                const currTotalCount = this._connectionsPerIPv4.get(netAddress) || 0;
                const currRateCount = this._connectionsInTimePerIPv4.get(netAddress) || 0;
                if (currTotalCount >= this.config.maxConnPerIP || currRateCount >= this.config.maxConnInTimePerIP) {
                    return true;
                }
                this._connectionsPerIPv4.put(netAddress, currTotalCount + 1);
                this._connectionsInTimePerIPv4.put(netAddress, currRateCount + 1);
                console.log('rates', currTotalCount + 1, currRateCount + 1);
            } else if (netAddress.isIPv6()) {
                const prefix = netAddress.ip.subarray(0, 8);
                const currTotalCount = this._connectionsPerIPv6.get(prefix) || 0;
                const currRateCount = this._connectionsInTimePerIPv6.get(prefix) || 0;
                if (currTotalCount >= this.config.maxConnPerIP || currRateCount >= this.config.maxConnInTimePerIP) {
                    return true;
                }
                this._connectionsPerIPv6.put(prefix, currTotalCount + 1);
                this._connectionsInTimePerIPv6.put(prefix, currRateCount + 1);
                console.log('rates', currTotalCount + 1, currRateCount + 1);
            }
        }
        return false;
    }

    _calculateHashrate() {
        if (!this.consensus.established) return;

        const shareDifficulty = this._totalShareDifficulty.minus(this._lastShareDifficulty);
        this._lastShareDifficulty = this._totalShareDifficulty;

        const hashrate = shareDifficulty.div(PoolServer.HASHRATE_INTERVAL / 1000).times(Math.pow(2 ,16));
        this._hashrates.push(Math.round(hashrate.toNumber()));
        if (this._hashrates.length > 10) this._hashrates.shift();

        let hashrateSum = 0;
        for (const hr of this._hashrates) {
            hashrateSum += hr;
        }
        this._averageHashrate = hashrateSum / this._hashrates.length;

        Nimiq.Log.d(PoolServer, `Pool hashrate is ${Math.round(this._averageHashrate)} H/s (10 min average)`);
    }

    /**
     * @param {number} userId
     * @param {number} deviceId
     * @param {BlockHeader} header
     * @param {BigNumber} difficulty
     */
    async storeShare(userId, deviceId, header, difficulty) {
        let submittedShares;
        if (!this._shares.contains(userId)) {
            submittedShares = new Nimiq.HashMap();
            this._shares.put(userId, submittedShares);
        } else {
            submittedShares = this._shares.get(userId);
        }
        let sharesForPrevious;
        if (!submittedShares.contains(header.prevHash.toString())) {
            sharesForPrevious = [];
            submittedShares.put(header.prevHash.toString(), sharesForPrevious);
        } else {
            sharesForPrevious = submittedShares.get(header.prevHash);
        }
        if (!sharesForPrevious.includes(header.hash().toString())) {
            sharesForPrevious.push(header.hash().toString());
        } else {
            throw new Error("Share inserted twice");
        }

        const prevBlockId = await this._getStoreBlockId(header.prevHash, header.height - 1, header.timestamp);
        const key = `${userId}:${deviceId}:${prevBlockId}`;
        let summary;
        if (!this._shareSummary.contains(key)) {
            summary = {
                userId, deviceId, prevBlockId,
                difficulty: new Nimiq.BigNumber(0),
                count: 0
            };
            this._shareSummary.put(key, summary)
        } else {
            summary = this._shareSummary.get(key);
        }
        summary.difficulty = summary.difficulty.plus(difficulty);
        summary.count += 1;
    }

    /**
     * @param {number} user
     * @param {Nimiq.Hash} shareHash
     * @returns {boolean}
     */
    async containsShare(user, shareHash) {
        if (this._shares.contains(user)) {
            const userHashesMap = this._shares.get(user);
            for (const key of userHashesMap.keys()) {
                if (userHashesMap.get(key).includes(shareHash.toString())) {
                    return true;
                }
            }
        }
        return false;
    }

    async _flushSharesToDb() {
        if (this._shareSummary.length === 0) return;
        let sharesBackup = this._shareSummary;
        this._shareSummary = new Nimiq.HashMap();

        let query = `
            INSERT INTO shares (user, device, prev_block, count, difficulty)
            VALUES ` + Array(sharesBackup.length).fill('(?,?,?,?,?)').join(', ') + ` ` +
            `ON DUPLICATE KEY UPDATE count=count+values(count), difficulty=difficulty+values(difficulty)`;
        let queryArgs = [];
        for (const summary of sharesBackup.valueIterator()) {
            queryArgs.push(summary.userId, summary.deviceId, summary.prevBlockId, summary.count, +summary.difficulty);
        }
        await this.connectionPool.execute(query, queryArgs);
    }

    /**
     * @param {Nimiq.Hash} oldShareHash
     * @private
     */
    async _removeOldShares(oldShareHash) {
        for (let userId of this._shares.keys()) {
            let userHashesMap = this._shares.get(userId);
            for (let key of userHashesMap.keys()) {
                if (key === oldShareHash.toString()) {
                    userHashesMap.remove(key);
                } else {
                    const block = await this.consensus.blockchain.getBlock(Nimiq.Hash.fromBase64(key));
                    if (block && block.header.timestamp * 1000 > this.consensus.network.time + Nimiq.Block.TIMESTAMP_DRIFT_MAX * 1000) {
                        userHashesMap.remove(key);
                    }
                }
            }
        }
    }

    /**
     * @param {number} userId
     * @param {boolean} includeVirtual
     * @returns {Promise<number>}
     */
    async getUserBalance(userId, includeVirtual = false) {
        return await Helper.getUserBalance(this._config, this.connectionPool, userId, this.consensus.blockchain.height, includeVirtual);
    }

    /**
     * @param {number} userId
     */
    async storePayoutRequest(userId) {
        const query = "INSERT IGNORE INTO payout_request (user) VALUES (?)";
        const queryArgs = [userId];
        await this.connectionPool.execute(query, queryArgs);
    }

    /**
     * @param {number} userId
     * @returns {Promise.<boolean>}
     */
    async hasPayoutRequest(userId) {
        const query = `SELECT * FROM payout_request WHERE user=?`;
        const [rows, fields] = await this.connectionPool.execute(query, [userId]);
        return rows.length > 0;
    }

    /**
     * @param {Hash} blockHash
     * @param {number} height
     * @param {number} timestamp
     * @returns {Promise.<number>}
     */
    async _getStoreBlockId(blockHash, height, timestamp) {
        let id = this._blockHashToId.get(blockHash);
        if (!id) {
            id = await Helper.getStoreBlockId(this.connectionPool, blockHash, height, timestamp);
            this._blockHashToId.set(blockHash, id);
        }
        return Promise.resolve(id);
    }

    /**
     * @param {Nimiq.Address} addr
     * @returns {Promise.<number>}
     */
    async getStoreUserId(addr) {
        let userId = this._userAddressToId.get(addr);
        if (!userId) {
            userId = await Helper.getStoreUserId(this.connectionPool, addr);
            this._userAddressToId.set(addr, userId);
        }
        return userId;
    }

    /**
     * @param {PoolAgent} agent
     */
    removeAgent(agent) {
        if (agent.mode === PoolAgent.Mode.REMOVED) return;
        agent.mode = PoolAgent.Mode.REMOVED;
        if (!agent.netAddress.isPrivate()) {
            // Remove one connection from total count per IP
            if (agent.netAddress.isIPv4()) {
                const currTotalCount = this._connectionsPerIPv4.get(agent.netAddress) || 0;
                if (currTotalCount <= 1) {
                    this._connectionsPerIPv4.remove(agent.netAddress);
                }
                this._connectionsPerIPv4.put(agent.netAddress, currTotalCount - 1);
            } else if (agent.netAddress.isIPv6()) {
                const prefix = agent.netAddress.ip.subarray(0, 8);
                const currTotalCount = this._connectionsPerIPv6.get(prefix) || 0;
                if (currTotalCount <= 1) {
                    this._connectionsPerIPv6.remove(prefix);
                }
                this._connectionsPerIPv6.put(prefix, currTotalCount - 1);
            }
        }
        this._agents.delete(agent);
    }

    /**
     * @type {{ unregistered: number, smart: number, nano: number}}
     */
    getClientModeCounts() {
        let ret = { unregistered: 0, smart: 0, nano: 0, dumb: 0 };
        for (const agent of this._agents) {
            ret[agent.mode]++;
        }
        return ret;
    }

    /**
     * @type {Nimiq.FullConsensus}
     * */
    get consensus() {
        return this._consensus;
    }

    /** @type {PoolConfig} */
    get config() {
        return this._config;
    }

    /**
     * @type {number}
     */
    get numIpsBanned() {
        return this._bannedIPv4IPs.length + this._bannedIPv6IPs.length;
    }

    /**
     * @type {number}
     */
    get numBlocksMined() {
        return this._numBlocksMined;
    }

    /**
     * @type {number}
     */
    get totalShareDifficulty() {
        return this._totalShareDifficulty;
    }

    /**
     * @type {number}
     */
    get averageHashrate() {
        return this._averageHashrate;
    }
}
PoolServer.DEFAULT_BAN_TIME = 1000 * 60 * 10; // 10 minutes
PoolServer.UNBAN_IPS_INTERVAL = 1000 * 60; // 1 minute
PoolServer.HASHRATE_INTERVAL = 1000 * 60; // 1 minute

module.exports = exports = PoolServer;
