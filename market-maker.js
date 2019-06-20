#!/usr/bin/env node
const chalk     = require('chalk')
const ethers    = require('ethers')
const _         = require('lodash')
const program   = require('commander')
const BigNumber = require('bignumber.js')
const Saturn    = require('@saturnnetwork/saturn.js').Saturn
const Strategy  = require('@saturnnetwork/market-maker-strategy').MarketMaker

const version   = require('./package.json').version
const saturnApi = 'https://ticker.saturn.network/api/v2'

const pipeline = async (funcs) => {
  return await funcs.reduce((promise, func) => {
    return promise.then(result => {
      return func().then(Array.prototype.concat.bind(result))
    })
  }, Promise.resolve([]))
}

async function makeNewOrder(elem, saturn, botconfig) {
  let executor = saturn[elem.blockchain.toLowerCase()]
  let tx = await executor
    .newOrder(botconfig.token, elem.order_type, elem.amount, elem.price)
  await saturn.query.awaitOrderTx(tx, executor)
}

async function makeNewTrade(elem, saturn, botconfig) {
  let executor = saturn[elem.blockchain.toLowerCase()]
  let tx = await executor.newTrade(elem.amount, elem.order_tx)
  await saturn.query.awaitTradeTx(tx, executor)
}

async function makeNewCancel(elem, saturn, botconfig) {
  let executor = saturn[elem.blockchain.toLowerCase()]
  let order = await saturn.query.getOrderByTx(elem.order_tx, elem.blockchain)
  let tx = await executor.cancelOrder(order.order_id, order.contract)
  await saturn.query.awaitTransaction(tx, executor, `Cancelling order ${elem.order_tx}`)
}

async function execute(actions, saturn, botconfig) {
  let updates = _.map(actions, elem => {
    if (elem.type === 'NewOrder') {
      return async () => await makeNewOrder(elem, saturn, botconfig)
    } else if (elem.type === 'Trade') {
      return async () => await makeNewTrade(elem, saturn, botconfig)
    } else if (elem.type === 'CancelOrder') {
      return async () => await makeNewCancel(elem, saturn, botconfig)
    } else {
      console.log('Unknown event type')
      return () => new Promise()
    }
  })
  await pipeline(updates).catch(console.error.bind(console))
}

function makeBotConfig(botconfig) {
  let rpcurl = botconfig.provider || rpcNode(botconfig.blockchain)
  let chainId = getChainId(botconfig.blockchain)
  let provider = new ethers.providers.JsonRpcProvider(rpcurl, { chainId: chainId, name: botconfig.blockchain })
  let saturn = new Saturn(saturnApi)

  botconfig.provider = provider
  botconfig.saturn = saturn
  botconfig.fundMinimum = new BigNumber(botconfig.fundMinimum)
  botconfig.tokenLimit = new BigNumber(botconfig.tokenLimit)
  botconfig.spread = new BigNumber(botconfig.spread)
  botconfig.dustCutoff = new BigNumber(botconfig.dustCutoff)
  botconfig.bandSize = new BigNumber(botconfig.bandSize)

  return botconfig
}

function getChainId(chain) {
  if (chain === 'ETC') { return 61 }
  if (chain === 'ETH') { return 1 }
  console.log('Unknown chainId for chain', chain)
  process.exit(1)
}

function rpcNode(chain) {
  if (chain === 'ETC') { return 'https://etc-rpc.binancechain.io/' }
  if (chain === 'ETH') { return 'https://mainnet.infura.io/mew' }
  console.log('Unknown chainId for chain', chain)
  process.exit(1)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeSaturnClient(blockchain, program, wallet) {
  let rpcnode = rpcNode(blockchain)
  let chainId = getChainId(blockchain)
  let provider = new ethers.providers.JsonRpcProvider(rpcnode, { chainId: chainId, name: blockchain })

  let saturn
  if (blockchain === 'ETC') {
    saturn = new Saturn(saturnApi, { etc: wallet.connect(provider) })
  } else {
    saturn = new Saturn(saturnApi, { eth: wallet.connect(provider) })
  }

  return saturn
}

program
  .version(version, '-v, --version')
  .description('Market making bot for Saturn Network')
  .option('-p, --pkey [pkey]', 'Private key of the wallet to use for trading')
  .option('-m, --mnemonic [mnemonic]', 'Mnemonic (i.e. from Saturn Wallet) of the wallet to use for trading')
  .option('-i, --walletid [walletid]', 'If using a mnemonic, choose which wallet to use. Default is Account 2 of Saturn Wallet / MetaMask.', 2)
  .option('-j, --json [json]', 'Trading bot config file')
  .option('-d, --delay [delay]', 'Polling delay in seconds', 60)
  .parse(process.argv)

if (!program.mnemonic && !program.pkey) {
  console.error('At least one of [pkey], [mnemonic] must be supplied')
  process.exit(1)
}

if (program.mnemonic && program.pkey) {
  console.error('Only one of [pkey], [mnemonic] must be supplied')
  process.exit(1)
}

let wallet
if (program.mnemonic) {
  let walletid = parseInt(program.walletid) - 1
  wallet = ethers.Wallet.fromMnemonic(program.mnemonic, `m/44'/60'/0'/0/${walletid}`)
} else {
  wallet = new ethers.Wallet(program.pkey)
}

if (!program.json) {
  console.error('Must specify bot config .json file location')
  process.exit(1)
}

let botconfig = makeBotConfig(require(program.json))
console.log(chalk.green(`Loading market-maker bot v${version} ...`))
let strategy = new Strategy(botconfig, wallet.address)
let saturn = makeSaturnClient(botconfig.blockchain, program, wallet)

let trade = async function() {
  try {
    actions = await strategy.getActions()
    if (actions.length) { await execute(actions, saturn, botconfig) }
  } catch(e) {
    console.error(e)
  }
  setTimeout(trade, parseInt(program.delay) * 1000)
};

(async () => await trade())()
