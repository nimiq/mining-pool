const fs = require('fs');
const https = require('https');
const btoa = require('btoa');
const Nimiq = require('@nimiq/core');

class MetricsServer {
    constructor(sslKeyPath, sslCertPath, port, password) {

        const options = {
            key: fs.readFileSync(sslKeyPath),
            cert: fs.readFileSync(sslCertPath)
        };

        https.createServer(options, (req, res) => {
            if (req.url !== '/metrics') {
                res.writeHead(301, {'Location': '/metrics'});
                res.end();
            } else if (password && req.headers.authorization !== `Basic ${btoa(`metrics:${password}`)}`) {
                res.writeHead(401, {'WWW-Authenticate': 'Basic realm="Use username metrics and user-defined password to access metrics." charset="UTF-8"'});
                res.end();
            } else {
                this._metrics(res);
                res.end();
            }
        }).listen(port);

        /** @type {Map.<string, {occurrences: number, timeSpentProcessing: number}>} */
        this._messageMeasures = new Map();
    }

    /**
     * @param {PoolServer} poolServer
     */
    init(poolServer) {
        /** @type {PoolServer} */
        this._poolServer = poolServer;
    }

    get _desc() {
        return {
            name: this._poolServer.name
        };
    }

    /**
     * @param {object} more
     * @returns {object}
     * @private
     */
    _with(more) {
        const res = this._desc;
        Object.assign(res, more);
        return res;
    }

    _metrics(res) {
        const clientCounts = this._poolServer.getClientModeCounts();
        MetricsServer._metric(res, 'pool_clients', this._with({client: 'unregistered'}), clientCounts.unregistered);
        MetricsServer._metric(res, 'pool_clients', this._with({client: 'smart'}), clientCounts.smart);
        MetricsServer._metric(res, 'pool_clients', this._with({client: 'nano'}), clientCounts.nano);
        MetricsServer._metric(res, 'pool_clients', this._with({client: 'dumb'}), clientCounts.dumb);

        MetricsServer._metric(res, 'pool_ips_banned', this._desc, this._poolServer.numIpsBanned);
        MetricsServer._metric(res, 'pool_blocks_mined', this._desc, this._poolServer.numBlocksMined);
        MetricsServer._metric(res, 'pool_total_share_difficulty', this._desc, this._poolServer.totalShareDifficulty);

        MetricsServer._metric(res, 'chain_head_height', this._desc, this._poolServer.consensus.blockchain.head.height);
        MetricsServer._metric(res, 'consensus_min_fee', this._desc, this._poolServer.consensus.minFeePerByte);

        const txs = this._poolServer.consensus.mempool.getTransactions();
        const group = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
        for (let i = 1; i < group.length; ++i) {
            MetricsServer._metric(res, 'mempool_transactions', this._with({'fee_per_byte': `<${group[i]}`}), txs.filter((tx) => tx.feePerByte >= group[i - 1] && tx.feePerByte < group[i]).length);
        }
        MetricsServer._metric(res, 'mempool_transactions', this._with({'fee_per_byte': `>=${group[group.length - 1]}`}), txs.filter((tx) => tx.feePerByte >= group[group.length - 1]).length);
        MetricsServer._metric(res, 'mempool_size', this._desc, txs.reduce((a, b) => a + b.serializedSize, 0));

        /** @type {Map.<string, number>} */
        const peers = new Map();
        for (let connection of this._poolServer.consensus.network.connections.values()) {
            let o = {};
            switch (connection.peerAddress ? connection.peerAddress.protocol : -1) {
                case Nimiq.Protocol.DUMB:
                    o.type = 'dumb';
                    break;
                case Nimiq.Protocol.WSS:
                    o.type = 'websocket-secure';
                    break;
                case Nimiq.Protocol.RTC:
                    o.type = 'webrtc';
                    break;
                case Nimiq.Protocol.WS:
                    o.type = 'websocket';
                    break;
                default:
                    o.type = 'unknown';
            }
            switch (connection.state) {
                case Nimiq.PeerConnectionState.NEW:
                    o.state = 'new';
                    break;
                case Nimiq.PeerConnectionState.CONNECTING:
                    o.state = 'connecting';
                    break;
                case Nimiq.PeerConnectionState.CONNECTED:
                    o.state = 'connected';
                    break;
                case Nimiq.PeerConnectionState.NEGOTIATING:
                    o.state = 'negotiating';
                    break;
                case Nimiq.PeerConnectionState.ESTABLISHED:
                    o.state = 'established';
                    break;
                case Nimiq.PeerConnectionState.CLOSED:
                    o.state = 'closed';
            }
            if (connection.peer) {
                o.version = connection.peer.version;
                o.agent = connection.peer.userAgent ? connection.peer.userAgent : undefined;
            }
            const os = JSON.stringify(o);
            if (peers.has(os)) {
                peers.set(os, peers.get(os) + 1);
            } else {
                peers.set(os, 1);
            }
        }
        /** @type {Map.<string, number>} */
        const addresses = new Map();
        for (let address of this._poolServer.consensus.network.addresses.iterator()) {
            let type = 'unknown';
            switch (address.peerAddress.protocol) {
                case Nimiq.Protocol.DUMB:
                    type = 'dumb';
                    break;
                case Nimiq.Protocol.WSS:
                    type = 'websocket-secure';
                    break;
                case Nimiq.Protocol.RTC:
                    type = 'webrtc';
                    break;
                case Nimiq.Protocol.WS:
                    type = 'websocket';
            }
            if (addresses.has(type)) {
                addresses.set(type, addresses.get(type) + 1);
            } else {
                addresses.set(type, 1);
            }
        }

        for (let os of peers.keys()) {
            MetricsServer._metric(res, 'network_peers', this._with(JSON.parse(os)), peers.get(os));
        }
        for (let type of addresses.keys()) {
            MetricsServer._metric(res, 'network_known_addresses', this._with({type: type}), addresses.get(type));
        }

        MetricsServer._metric(res, 'network_bytes', this._with({'direction': 'sent'}), this._poolServer.consensus.network.bytesSent);
        MetricsServer._metric(res, 'network_bytes', this._with({'direction': 'received'}), this._poolServer.consensus.network.bytesReceived);
    }

    /**
     * @param res
     * @param {string} key
     * @param {object} attributes
     * @param {number} value
     * @private
     */
    static _metric(res, key, attributes, value) {
        res.write(`${key}{${Object.keys(attributes).map((a) => `${a}="${attributes[a]}"`).join(',')}} ${value}\n`);
    }
}

module.exports = exports = MetricsServer;
