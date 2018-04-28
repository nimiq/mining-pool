# Nimiq Mining-Pool Server
This mining pool server combines resources of multiple clients mining on the Nimiq blockchain.
Clients are independent network nodes and generate or validate blocks themselves to support decentralization.
Details about the mining pool protocol can be found [here](https://nimiq-network.github.io/developer-reference/chapters/pool-protocol.html#mining-pool-protocol).
A mining pool client is implemented in [Nimiq Core](https://github.com/nimiq-network/core/tree/master/src/main/generic/miner).

**Operating a public mining-pool in the mainnet makes you responsible for other people's money. Test your pool setup in the testnet first!**

## Architecture
The pool server consists of three parts which communicate through a common MySQL-compatible database (schema see `sql/create.sql`)
* The pool **server** interacts with clients and verifies their shares. There can be multiple pool server instances.
* The pool **service** computes client rewards using a PPLNS reward system.
* The pool **payout** processes automatic payouts above a certain user balance and payout requests.

While the server(s) and the service are designed to run continuously, the pool payout has to be executed whenever a payout is desired.

## Run
Run `node index.js --config=[CONFIG_FILE]`. See `[server|service|payout].sample.conf` for sample configuration files and clarifications.

## License
    Copyright 2018 The Nimiq Foundation

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
