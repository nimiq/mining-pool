const fs = require('fs');
const mysql = require('mysql2/promise');

const Nimiq = require('../../core/dist/node.js');

const PoolAgent = require('../PoolAgent.js');
const PoolServer = require('../PoolServer.js');
const PoolService = require('../PoolService.js');

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
            const poolServer = new PoolServer(consensus, 'Test Pool', POOL_ADDRESS, 9999, '', '', '', '');
            await poolServer.start();

            let poolAgent = new PoolAgent(poolServer, { close: () => {}, send: () => {}, _socket: { remoteAddress: '1.2.3.4' } });
            await poolAgent._onRegisterMessage(NQ25sampleData.register);

            poolAgent = new PoolAgent(poolServer, { close: () => {}, send: () => {}, _socket: { remoteAddress: '1.2.3.4' } });
            await poolAgent._onRegisterMessage(NQ43sampleData.register);

            const poolService = new PoolService(consensus, POOL_ADDRESS);
            await poolService.start();

            // console.log(await consensus.blockchain.pushBlock(ChainSampleData.block1));
            await poolService._distributePayinsForBlock(ChainSampleData.block1);
            done();
        })().catch(done.fail);
    });
});
