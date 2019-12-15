const _ = require('lodash')
const assert = require('assert')
const {transformNode} = require('./pool/node')
const {transformNymAttrib} = require('./domain/nym-attrib')
const {txTypeToSubledgerName, txTypeToTxName, subledgerNameToId} = require('../types')

function createEsTxTransform (resolveDomainTxBySeqNo) {
  function noop (tx) {
    return Object.assign({}, tx)
  }

  const txTransforms = {
    'NYM': transformNymAttrib,
    'ATTRIB': transformNymAttrib,
    'SCHEMA': noop,
    'CLAIM_DEF': createClaimDefTransform(resolveDomainTxBySeqNo),
    'REVOC_REG_DEF': noop,
    'REVOC_REG_ENTRY': noop,
    'SET_CONTEXT': noop,
    'NODE': transformNode,
    'POOL_UPGRADE': transformPoolUpgrade,
    'NODE_UPGRADE': noop,
    'POOL_CONFIG': noop,
    'AUTH_RULE': noop,
    'AUTH_RULES': noop,
    'TXN_AUTHOR_AGREEMENT': noop,
    'TXN_AUTHOR_AGREEMENT_AML': noop,
    'SET_FEES': noop,
    'UNKNOWN': noop
  }

  async function createEsTransformedTx (tx) {
    if (!tx) {
      throw Error('tx argument not defined')
    }
    const {type: txnType} = tx.txn
    assert(txnType !== undefined)
    const txnTypeName = txTypeToTxName(txnType) || 'UNKNOWN'
    const subledgerName = txTypeToSubledgerName(txnType) || 'UNKNOWN'
    const subledgerCode = subledgerNameToId(subledgerName) || 'UNKNOWN'
    const transform = txTransforms[txnTypeName]
    let transformed = await transform(_.cloneDeep(tx))
    if (transformed.txnMetadata.txnTime) {
      let epochMiliseconds = transformed.txnMetadata.txnTime * 1000
      transformed.txnMetadata.txnTime = new Date(epochMiliseconds).toISOString()
    }
    transformed.txn.typeName = txnTypeName
    transformed.subledger = {
      code: subledgerCode,
      name: subledgerName
    }
    return transformed
  }

  return createEsTransformedTx
}

module.exports.createEsTxTransform = createEsTxTransform
