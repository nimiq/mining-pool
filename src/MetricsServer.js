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

        MetricsServer._metric(res, 'pool_ips_banned', this._desc, this._poolServer.numIpsBanned);
        MetricsServer._metric(res, 'pool_blocks_mined', this._desc, this._poolServer.numBlocksMined);
        MetricsServer._metric(res, 'pool_total_share_difficulty', this._desc, this._poolServer.totalShareDifficulty);
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
