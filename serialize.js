const BSON = require('bson');
const helpers = require('cry-helpers');
const { inflate, deflate } = require('pako');

BSON.setInternalBufferSize(500000000);

// const serialize = JSON.stringify
// const deserialize = JSON.parse

const serialize = BSON.serialize
const deserialize = BSON.deserialize

function pack(data) 
{
    data = helpers.serialize.pack(data)
    return Buffer.from(deflate(serialize({l:data})));
}

function unpack(data)
{
    if (!data) return data;
    try {
        if ((Buffer.from('null')).equals(data)) return null;  // HACK: this should not be necessary
        let ret = deserialize(inflate(new Uint8Array(data))).l;
        ret = helpers.serialize.unpack(ret)
        return ret;
    } catch(err) {
        console.error('unpack error',err,(data||'').toString());
        return data;
    }
}

module.exports = 
{
    pack,
    unpack
}