const fs = require('fs');
const mysql = require('mysql2/promise');

const Nimiq = require('@nimiq/core');

const PoolAgent = require('../src/PoolAgent.js');
const PoolServer = require('../src/PoolServer.js');
const PoolService = require('../src/PoolService.js');

describe('PoolService', () => {

    beforeEach(() => {
        spyOn(PoolServer, 'createServer').and.callFake(() => {
            return {
                on: () => {},
                close: () => {}
            };
        });
    });

    it('computes payins', (done) => {
        (async () => {
            const consensus = await Nimiq.Consensus.volatileFull();
            const poolServer = new PoolServer(consensus, POOL_CONFIG, 9999, '', '', '', '');
            await poolServer.start();

            let poolAgent = new PoolAgent(poolServer, { close: () => {}, send: () => {}, _socket: { remoteAddress: '1.2.3.4' } });
            await poolAgent._onRegisterMessage(NQ25sampleData.register);

            poolAgent = new PoolAgent(poolServer, { close: () => {}, send: () => {}, _socket: { remoteAddress: '1.2.3.4' } });
            await poolAgent._onRegisterMessage(NQ43sampleData.register);

            const poolService = new PoolService(consensus, POOL_CONFIG);
            await poolService.start();

            // console.log(await consensus.blockchain.pushBlock(ChainSampleData.block1));
            await poolService._distributePayinsForBlock(ChainSampleData.block1);
            done();
        })().catch(done.fail);
    });
});
