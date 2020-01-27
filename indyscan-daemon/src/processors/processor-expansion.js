const logger = require('../logging/logger-main')
const geoip = require('geoip-lite')
const _ = require('lodash')
const assert = require('assert')
const { transformPoolUpgrade } = require('./expansion/config/pool-upgrade')
const { createClaimDefTransform } = require('./expansion/domain/claim-def')
const { createNodeTransform } = require('./expansion/pool/node')
const { transformNymAttrib } = require('./expansion/domain/nym-attrib')
const { txTypeToSubledgerName, txTypeToTxName, subledgerNameToId } = require('indyscan-txtype/src/types')

const geoipLiteLookupIp = geoip.lookup.bind(geoip)

function createProcessorExpansion ({id, sourceLookups}) {
  let resolveDomainTxBySeqNo = async (seqNo) => {
    return await sourceLookups.getTx('domain', seqNo, 'original')
  }

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
    'NODE': createNodeTransform(geoipLiteLookupIp),
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

  /*
  Should never throw. If tx specific transformation fails, this informmation will be captured in result object under
  "transformed.meta.transformError" object with fields "message" and "stack"
   */
  async function transformTx (tx) {
    if (!tx) {
      throw Error('tx argument not defined')
    }
    const { type: txnType } = tx.txn
    assert(txnType !== undefined)
    const txnTypeName = txTypeToTxName(txnType) || 'UNKNOWN'
    const subledgerName = txTypeToSubledgerName(txnType) || 'UNKNOWN'
    const subledgerCode = subledgerNameToId(subledgerName) || 'UNKNOWN'
    let transformed = _.cloneDeep(tx)

    // genesis txs do not have time
    if (transformed.txnMetadata && transformed.txnMetadata.txnTime) {
      let epochMiliseconds = transformed.txnMetadata.txnTime * 1000
      transformed.txnMetadata.txnTime = new Date(epochMiliseconds).toISOString()
    }
    transformed.txn.typeName = txnTypeName
    transformed.subledger = {
      code: subledgerCode,
      name: subledgerName
    }
    transformed.meta = {}

    try {
      const transform = txTransforms[txnTypeName]
      transformed = await transform(transformed)
    } catch (err) {
      transformed.meta.transformError = {
        message: err.message,
        stack: err.stack
      }
    }
    return transformed
  }

  function getEsDomainMappings() {
    return {
      // TX: NYM, ATTRIB
      'indyscan.txn.data.raw': { type: 'text' },
      'indyscan.txn.data.dest': { type: 'keyword' },
      'indyscan.txn.data.verkeyFull': { type: 'keyword' },
      'indyscan.txn.data.roleAction': { type: 'keyword' },

      // TX: CLAIM_DEF
      'indyscan.txn.data.refSchemaTxnSeqno': { type: 'integer' },
      'indyscan.txn.data.refSchemaTxnTime': { type: 'date', format: 'date_time' },
      'indyscan.txn.data.refSchemaVersion': { type: 'keyword' },
      'indyscan.txn.data.refSchemaFrom': { type: 'keyword' },

    }
  }

  function getEsPoolMappings() {
    return {
      // TX: pool NODE transaction
      'indyscan.txn.data.data.client_ip': { type: 'text', 'fields': { 'raw': { 'type': 'keyword' }, 'as_ip': { type: 'ip', 'ignore_malformed': true } } },
      'indyscan.txn.data.data.client_port': { type: 'integer' },
      'indyscan.txn.data.data.node_ip': { type: 'text', 'fields': { 'raw': { 'type': 'keyword' }, 'as_ip': { type: 'ip', 'ignore_malformed': true } } },
      'indyscan.txn.data.data.node_ip_text': { type: 'text' },
      'indyscan.txn.data.data.node_port': { type: 'integer' },

      // TX: NODE tx geo information
      'indyscan.txn.data.data.client_ip_geo.location': { type: 'geo_point' },
      'indyscan.txn.data.data.client_ip_geo.eu': { type: 'boolean' },
      'indyscan.txn.data.data.node_ip_geo.location': { type: 'geo_point' },
      'indyscan.txn.data.data.node_ip_geo.eu': { type: 'boolean' },
    }
  }

  function getEsConfigMappings() {
    return {
      // config POOL UPGRADE
      'indyscan.txn.data.schedule.scheduleKey': { type: 'keyword' },
      'indyscan.txn.data.schedule.scheduleTime': { type: 'date', format: "strict_date_optional_time||epoch_millis||yyyy-MM-dd'T'HH:mm:ss.SSSZZ||yyyy-MM-dd'T'HH:mm.SSSZZ", 'ignore_malformed': true },

      // TX: domain AUTHOR_AGREEMENT_AML
      'indyscan.txn.data.aml.at_submission': { type: 'text', analyzer: 'english' },
      'indyscan.txn.data.aml.click_agreement': { type: 'text', analyzer: 'english' },
      'indyscan.txn.data.aml.for_session': { type: 'text', analyzer: 'english' },
      'indyscan.txn.data.aml.on_file': { type: 'text', analyzer: 'english' },
      'indyscan.txn.data.aml.product_eula': { type: 'text', analyzer: 'english' },
      'indyscan.txn.data.aml.service_agreement': { type: 'text', analyzer: 'english' },
      'indyscan.txn.data.aml.wallet_agreement': { type: 'text', analyzer: 'english' },

      // TX: domain AUTHOR_AGREEMENT
      'indyscan.txn.data.text': { type: 'text', analyzer: 'english' }
    }
  }

  function getEsCommonMappings() {
    return {
      // Every tx
      'indyscan.ver': { type: 'keyword' },
      'indyscan.rootHash': { type: 'keyword' },
      'indyscan.txn.type': { type: 'keyword' },
      'indyscan.txn.typeName': { type: 'keyword' },
      'indyscan.subledger.code': { type: 'keyword' },
      'indyscan.subledger.name': { type: 'keyword' },
      'indyscan.txn.protocolVersion': { type: 'keyword' },
      'indyscan.txn.metadata.from': { type: 'keyword' },
      'indyscan.txn.metadata.reqId': { type: 'keyword' },
      'indyscan.txn.data.data.blskey': { type: 'keyword' },
      'indyscan.txn.data.data.blskey_pop': { type: 'keyword' },
      'indyscan.meta.scanTime': { type: 'date', format: 'date_time' },

      'indyscan.txnMetadata.seqNo': { type: 'integer' },
      'indyscan.txnMetadata.txnTime': { type: 'date', format: 'date_time' },
    }
  }

  // TODO: This gotta go out here, not responsibility of this module to care about original tx format
  function getEsOriginalFormatMapping() {
    return {
      "original": { type: 'text', index: false },
    }
  }

  function getEsLegacyAllInOneMappings() {
    return {
      "properties": {
        ... getEsCommonMappings(),
        ... getEsDomainMappings(),
        ... getEsPoolMappings(),
        ... getEsConfigMappings(),
        ... getEsOriginalFormatMapping()
      }
    }
  }

    return {
    transformTx,
    getEsLegacyAllInOneMappings
  }
}


module.exports.createProcessorExpansion = createProcessorExpansion
