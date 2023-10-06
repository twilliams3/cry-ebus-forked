//@ts-check
'use strict';

const DefferedPromise = require('cry-helpers').DefferedPromise;
/**
 * A request promise that resolves when worker submits a result, 
 * rejects on timeout or error. 
 * @property {String} rid - unique request id
 */
class RequestPromise extends DefferedPromise {
    constructor() {
        super();
        this.rid = null;
    }
}

/**
* @typedef {Object} EbusRequest
* @property {String} rid - unique request id
* @property {String} service - service id
* @property {any} data - request's data payload, unpacked, not serialized
* @property {Number} [stalesMs] - miliseconds before request stalesMs
* @property {Number} [resendMs] - miliseconds before re-sending the request stalesMs
* @property {Date} [expires] - absolute time when to expire the request, calculated using "stalesMs"
* @property {Date} [resend] - absoulte time when to resend the request, calculated using "resendMs"
* @property {RequestPromise?} [promise] - a promise used to fullfil the request (if request bt Request promise)
* @property {Boolean?} [returnRawData] - if true do not unserialize received data
* @property {Boolean?} [sendRawData] - if true do not serialize sent data
*/

/**
 * @typedef {Object} ClientConfig
 * @property {String} [server] - default 'tcp://localhost'
 * @property {String} [frontend] - default '[SERVER]:' + consts.FRONTEND
 * @property {String} [pub] - default '[SERVER]:' + consts.PUB
 * @property {String} [sub] - default '[SERVER]:' + consts.SUB
 * @property {Number} [heartbeat] - ms between heartbeats - default consts.HEARTBEATMS
 * @property {Number} [expires] - ms before request expires - default consts.EXPIRERQMS
 * @property {Number} [resends] - ms till clients resends the message to worker - default consts.EXPIRERQMS
 * @property {Number} [resendx] - resend request to worker after (resendx * req.stalesMs) - default consts.RESENDRQX,
 * @property {String} [uid] - default 'C' + uuid(),
 * @property {Number} [debug] - default 1,
 * @property {Boolean} [noHeartbeat] - default false
 */


const modules = [ 'EBUS', 'EBUS_CLIENT' ]
const zmq = require('zeromq');
const { v1: uuid } = require('uuid');
const events = require('events');
const consts = require('./consts');
const log = new(require('cry-helpers').Log)(modules);
const envconf = require('cry-helpers').getConf;
const dotenv = require('dotenv')
const dotenvExpand = require('dotenv-expand')
const { pack, unpack } = require('./serialize');
const helpers = require('cry-helpers');
const { send } = require('process');

/** @event Client#start */
/** @event Client#stop */
/** @event Client#online */
/** @event Client#offline */
/**
 * @event Client#error
 * @type {String | Object}
 */
/**
 * @event Client#services
 * @type {Array<String>}
 */
/**
 * @event Client#services
 * @type {Array<String>}
 */
/**
 * @event Client#workers
 * @type {Array<import('./sharedTypes.js').WorkerStatusDescription>}
 */

// @ts-ignore
class Client extends events {

    /**
     * A new ebus client
     * @param {ClientConfig} config
     */
    constructor(config) {
        super()

        dotenvExpand(dotenv.config());
        
        /** @type {ClientConfig} */
        let defaults = {
            server: 'tcp://localhost',
            frontend: '[SERVER]:' + consts.FRONTEND,
            pub: '[SERVER]:' + consts.PUB,
            sub: '[SERVER]:' + consts.SUB, 
            heartbeat: consts.HEARTBEATMS,
            expires: consts.EXPIRERQMS,
            resends: consts.RESENDRQMS,
            resendx: consts.RESENDRQX,
            uid: 'C' + uuid(),
            debug: 1,
            noHeartbeat: false
        };

        /** @type {ClientConfig} */
        this.conf = envconf(modules,defaults,config)

        log.status('client starting with config',this.conf)
 
        if (this.conf.frontend.startsWith('[SERVER]')) this.conf.frontend=this.conf.frontend.replace('[SERVER]',this.conf.server);
        if (this.conf.pub.startsWith('[SERVER]')) this.conf.pub=this.conf.pub.replace('[SERVER]',this.conf.server);
        if (this.conf.sub.startsWith('[SERVER]')) this.conf.sub=this.conf.sub.replace('[SERVER]',this.conf.server);

        this.hbTimer = null // heart-beat timer
        this.msgTimer = null
        this.requestNum = 0
        /** @type {Map<string,EbusRequest>} */
        this.requests = new Map() // list of all outstanding requests
        this.subscriptions = new Map()
        this.started = false;
        this.isonline=  false;

        log.setLevel(this.conf.debug)
    }

    /**
     * Starts the ebus client.
     * The client will conect to the broker.
     */

    start() {

        log.info('client starting with config ', this.conf)

        this.stop();
        
        this.conf.uid = 'C' + uuid()
        this.socket = zmq.socket('dealer');
        this.socket.identity = this.conf.uid;
        this.socket.setsockopt('linger', 1);
        this.socket.on('message', this._onMessage.bind(this));
        this.socket.on('error', this._onError.bind(this))
        this.socket.connect(this.conf.frontend)
        this.liveness = consts.HEARTBEAT_LIVENESS_FOR_BROKER;
        
        this.started = true;

        if (this.conf.pub) {
            log.info('connecting pub', this.conf.pub)
            this.pub = zmq.socket('pub');
            this.pub.on('error', this._pubError.bind(this))
            this.pub.connect(this.conf.pub)
        }

        if (this.conf.sub) {
            log.info('connecting sub', this.conf.sub)
            this.sub = zmq.socket('sub')
            this.sub.on('error', this._subError.bind(this))
            this.sub.on('message', this._onNotification.bind(this))
            this.sub.connect(this.conf.sub)
            this.subscriptions.forEach(s =>  {
                this.sub.subscribe(s.toString()); }
            );
            this.sub.subscribe('ebus');
        }

        this._checkHeartbeat()
        this._checkMessages()
        this.emit('start')
    }

    /**
     * Stops the ebus client. 
     * The client will disconnect from the broker.
     */

    stop() {

        if (!this.started) return
        this.started = false;
        
        log.info('client stopping')

        this._sendDisconnect();
       // this._cancelAllRequests();

        this._clearHeatbeatTimer()
        this._clearMessagesTimer()

        if (this.socket) {
            this.socket.close()
            delete this.socket
        }
        if (this.pub) {
            this.pub.close()
            delete this.pub
        }
        if (this.sub) {
            this.sub.close()
            delete this.sub
        }
        this.emit('stop')
    }

    on(evt, callback) {
        return super.on(evt,callback)
    }

    off(evt, callback) {
        return super.off(evt, callback)
    }

    emit(...args) {
        return super.emit(...args)
    }

    /**
     * Returns online status of ebus client.
     */
    online()
    {
        return this.isonline;
    }

    /**
     * Request a promise that will fulfill when the request is processed,
     * or fail if it stalesMs (times-out) or errors.
     * @param {String} service - service to process the request
     * @param {any} data - payload send to the service
     * @param {string} rid - unique request id
     * @param {number} stalesMs - milliseconds before the request is dropped
     * @param {boolean?} returnRawData - if true, do not unpack the data
     * @param {boolean?} sendRawData - if true, send upacked data
     * @return {RequestPromise} [promise]- request promise
     */
    requestPromise(service, data, rid, stalesMs, returnRawData=false, sendRawData=false) {
        rid = this.request(service, data, rid, stalesMs, returnRawData, sendRawData);
        let req = this.requests.get(rid);
        req.promise = new RequestPromise();
        req.promise.rid = rid;
        req.returnRawData = !!returnRawData;
        req.sendRawData = !!sendRawData;
        return req.promise;
    }

    /**
    * Request a promise that will fulfill when the request is processed,
    * or fail if it stalesMs (times-out) or errors.
    * @param {String} service - service to process the request
    * @param {any} data - payload send to the service
    * @param {string} rid - unique request id
    * @param {number} stalesMs - milliseconds before the request is droppe
    * @param {boolean?} returnRawData - if true, do not unpack the data
    * @param {boolean?} returnRawData - if true, do not unpack the data
    * @param {boolean?} sendRawData - if true, send upacked data
    */
    request(service, data, rid, stalesMs, returnRawData=false, sendRawData=false) {
        rid = rid || uuid()
        stalesMs = stalesMs || this.conf.expires;
        let expires = new Date();
        expires.setTime(expires.getTime() + stalesMs);
        let resendMs = Math.max(this.conf.resends, stalesMs * this.conf.resendx);
        let resend = new Date();
        resend.setTime(resend.getTime() + resendMs);
     
        /** @type EbusRequest */
        var req = {
            rid,
            service,
            data,
            expires,
            resend,
            stalesMs,
            resendMs,
            returnRawData,
            sendRawData,
        };
        this.requests.set(rid, req);
        this._sendRequest(req);
        return rid
    }

    brokerServices() {
        log.debug(`sendig services enquiery`)
        this._send(['', consts.CLIENT, consts.SERVICES])
    }

    brokerWorkers() {
        log.debug(`sendig workers enquiery`)
        this._send(['', consts.CLIENT, consts.WORKERS])
    }

    /**
     * 
     * @param {String} channel - a channel to subscribe to (e.g. "db/tenant" subsctibes to "db/tenant", "db/tenant/users" etc)
     */
    subscribe(channel) {
        channel=channel.toString()
        log.info('subscribe', channel)        
        this.subscriptions.set(channel, channel)
        if (this.started) {
            this.sub.subscribe(channel);
        }
    }

    /**
     * Remove channel subscription
     * @param {String} channel 
     */
    unsubscribe(channel) {
        channel=channel.toString()
        log.info('unsubscribe', channel)        
        this.subscriptions.delete(channel)
        if (this.started) this.sub.unsubscribe(channel)
    }

    /**
     * Publish a message on channel
     * @param {String} channel 
     * @param {any} data 
     */
    publish(channel, data) {
        if (!this.conf.pub) {
            this.emit('error', 'pub port not defined')
            log.error('pub port not defined')
            return
        }
        log.info('publish', channel.toString(), data)
        this.pub.send([channel.toString(), pack(data)])
    }    

    /**
     * Sends a raw message to ebus broker.
     * @private
     * @param {Array} msg 
     */
    _send(msg) {
        if (!this.socket) return;
        this.socket.send(msg);
    }

    /** @private  */
    _onNotification(channel, data) {
        channel = (channel || '').toString()
        data = unpack(data);
        log.info('rcvd broadcast', channel)
        if (channel===consts.PUB_EBUS_SHUTDOWN) {
            log.info('server published shutdown')
            this.isonline=false;
            this.emit('offline');
        }

        this.emit('message', data, channel )
    }

    /** @private */
    _onError(err) {
        this.emit('error', err);
    }

    /** @private */
    _subError(err) {
        this.emit('error', err)
    }

    /** @private */
    _pubError(err) {
        this.emit('error', err)
    }

    /** @private */
    _onMessage() {
        let msg = [...arguments, null, null, null, null, null, null];

        var empty = (msg[0] || '').toString();
        var senderType = (msg[1] || '').toString();
        var messageType = (msg[2] || '').toString();
        var rid = (msg[3] || '').toString();
        var packedData = msg[4]

        if ([consts.PING, consts.HEARTBEAT].includes(messageType)) log.trace('rcvd msg', senderType, messageType)
        else log.debug('rcvd msg', senderType, messageType)

        this._gotHeartbeat();

        if (senderType !== consts.WORKER) {
            this.emit('error', 'client only accepts messages from workers ' + senderType + ' ' + messageType);
            return
        }

        if (messageType === consts.HEARTBEAT) {
            return;
        }

        if (messageType === consts.PING) {
            this._send(['', consts.CLIENT, consts.HEARTBEAT])
            return;
        }

        if (messageType === consts.DISCONNECT) {
            log.info('received DISCONNECT');
            this.start()
            return;
        }

        if (messageType === consts.SERVICES) {
            this.emit('services', unpack(packedData));
            return;
        }

        if (messageType === consts.WORKERS) {
            this.emit('workers', unpack(packedData));
            return;
        }

        if (messageType === consts.REPLY) {

            var req = this.requests.get(rid)
            if (!req) {
                this._send(['', consts.CLIENT, consts.REJECT, rid, 'no request with ' + rid])
                if (!req) return;
            }

            let data = req.returnRawData ? packedData : unpack(packedData);

            this.emit('reply', rid, data);
            if (req.promise) {
                req.promise.resolve({
                    rid,
                    data
                })
            }
            this.requests.delete(req.rid)
            return;
        }

        if (messageType === consts.REJECT) {
            var req = this.requests.get(rid)
            if (!req) return;
            this.emit('reject', req.service, rid, req.data);
            if (req.promise) {
                req.promise.reject({
                    rid: req.rid,
                    service: req.service,
                    originalData: req.data,
                    data: req.returnRawData ? null : unpack(packedData),
                    reason: 'reject'
                })
            }
            this.requests.delete(rid)
            return;
        }

        log.error(`did not process message`, msg)
    }

    /**
     * @private
     * @param {EbusRequest} req 
     */
    _sendRequest(req) {
        let resend = new Date();
        resend.setTime(resend.getTime() + req.resendMs);
        if (resend > req.expires) resend = req.expires;
        req.resend = resend;

        log.debug(`sendig request`, req.rid, req.service, req.data)
        this._send(['', consts.CLIENT, consts.REQUEST, req.service, req.rid, req.sendRawData ? req.data : pack(req.data), req.stalesMs ])
    }

    /**
    * 
    * @private 
    */
    _sendDisconnect() {
        this._send(['', consts.CLIENT, consts.DISCONNECT])
    }

    /**
     * 
     * @private 
     */
    _cancelAllRequests() {
        this.requests.forEach(req => {
            this._cancelRequest(req)
        })
    }

    /**
     * @private
     * @param {EbusRequest} req 
     */
    _cancelRequest(req) {
        log.info(`cancel request`, req.rid, req.service)
        this._send(['', consts.CLIENT, consts.CANCEL, req.service, req.rid])
    }

    /** @private */
    _clearHeatbeatTimer() {
        clearInterval(this.hbTimer);
        this.hbTimer = null;
    }

    /** @private */
    _clearMessagesTimer() {
        clearInterval(this.msgTimer);
        this.msgTimer = null;
    }

    /** @private */
    _checkMessages() {
        if (this.msgTimer) return;

        this.msgTimer = setInterval(() => {
            let now = new Date();
            this.requests.forEach(req => {
                if (req.expires < now) {
                    this.emit('expired', req.rid, req.service, req.data)
                    if (req.promise) {
                        log.info('rejecting promissed timeoutted', req.rid, req.data)
                        req.promise.reject({
                            rid: req.rid,
                            data: req.data,
                            reason: 'timeout'
                        })
                    }
                    this.requests.delete(req.rid)
                } else if (req.resend < now) this._sendRequest(req)
            })
        }, this.conf.heartbeat);
    }

    /** @private */
    _checkHeartbeat() {
        if (this.conf.noHeartbeat) return;
        if (this.hbTimer) return;
        this.hbTimer = setInterval(() => {
           let now = new Date();
            if (this.liveness-- > 0) {
                log.trace('PING broker', this.liveness)
                this._send(['', consts.CLIENT, consts.PING]);
            } else {

                if (this.isonline===true) {
                    this.isonline=false;
                    this.emit('offline')
                    log.error('heartbeats expired, restarting until reconnect')
                }

                this.start();
                this._resendAllUnexpiredRequests(now);
            }
        }, this.conf.heartbeat);
    }

    /** @private */
    _resendAllUnexpiredRequests(now) {
        now = now || new Date();
        this.requests.forEach(req => {
            if (now <= req.expires) {
                this._sendRequest(req);
            }
        });
    }

    /** @private */
    _gotHeartbeat() {
        this._clearHeatbeatTimer();
        this.liveness = consts.HEARTBEAT_LIVENESS_FOR_BROKER;
        this._checkHeartbeat();

        if (this.isonline===false) {
            this.isonline=true;
            this.emit('online');
            this._resendAllUnexpiredRequests();
        }
    }
}

module.exports = Client; 