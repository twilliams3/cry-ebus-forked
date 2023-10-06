//@ts-check

'use strict';

const zmq = require('zeromq');
const { v1: uuid } = require('uuid');
const events = require('events');
const consts = require('./consts');
const envconf = require('cry-helpers').getConf;
const dotenv = require('dotenv')
const dotenvExpand = require('dotenv-expand')
const { pack, unpack } = require('./serialize');
let pm2io = null

/**
 * @typedef WorkerConfig
 * @property {String} [server] - server locatio - default  'tcp://localhost',
 * @property {String} [backend] - default  '[SERVER]:' + consts.BACKEND,
 * @property {String} [pub] - default  '[SERVER]:' + consts.PUB,
 * @property {String} [sub] - default  '[SERVER]:' + consts.SUB,             
 * @property {Number} [heartbeat] - ms between heartbeats - default  consts.HEARTBEATMS,
 * @property {Number} [expiresMs] - ms to expire requests - default  consts.EXPIRESMS,
 * @property {String} [identity] - worker id - default  'W/' +service+'/' + uuid(),
 * @property {Number} [debug] - debug level - default  1
 * @property {Boolean} [reportToPm2] - default true,
 */


/**
 * @typedef WorkerRequest
 * @property {String} rid - rid,
 * @property {any} data - data,
 * @property {Date} expires - expires,
 * @property {Number} resend - 0,
 * @property {Number} receiveCount - 1,
 * @property {any} [response] - packed and serialized response data
 * @property {Boolean} [rejected] - true if this request was rejected
 */

// @ts-ignore
class Worker extends events {

    /**
     * 
     * @param {String} service 
     * @param {WorkerConfig} config
     */
    constructor(service, config) {

        super()
        
        dotenvExpand(dotenv.config());

        const modules = ['EBUS', 'EBUS_WORKER', `EBUS_WORKER_${service}`];

        if (!service) {
            this.log.fatal('service name not specified')
            throw 'service name not specified'
        }

        this.log = new (require('cry-helpers').Log)(modules);

        /** @type {WorkerConfig} */
        let defaults = {
            server: 'tcp://localhost',
            backend: '[SERVER]:' + consts.BACKEND,
            pub: '[SERVER]:' + consts.PUB,
            sub: '[SERVER]:' + consts.SUB,
            heartbeat: consts.HEARTBEATMS,
            expiresMs: consts.EXPIRERQMS,
            identity: 'W/' + service + '/' + uuid(),
            debug: 1,
            reportToPm2: true,
        };

        /** @type WorkerConfig */
        this.conf = envconf(modules, defaults, config);

        if (this.conf.backend.startsWith('[SERVER]')) this.conf.backend = this.conf.backend.replace('[SERVER]', this.conf.server);
        if (this.conf.pub.startsWith('[SERVER]')) this.conf.pub = this.conf.pub.replace('[SERVER]', this.conf.server);
        if (this.conf.sub.startsWith('[SERVER]')) this.conf.sub = this.conf.sub.replace('[SERVER]', this.conf.server);

        this.started = false
        this.service = service;
        this.identity = this.conf.identity;
        this.reqs = new Map()
        this.recvHeatbeatTimer = null
        this.sendHeartbeatTimer = null
        this.reqTimer = null
        this.requestNum = 0
        /** @type {Map<String,WorkerRequest>} */
        this.requests = new Map()
        this.readySent = false
        this.isonline = false
        this.subscriptions = new Map()
        this.waitingToReconnectSince = null
        this.starts = 0

        this.totalRequestCounts = { received: 0, responded: 0, rejected: 0 };

        if (this.conf.reportToPm2) {
            pm2io = require('@pm2/io') 
            let self = this;

            this.pm2_starts_metric = pm2io.metric({
                name: 'ebus starts'
            });
            this.pm2_open_requests = pm2io.metric({
                name: 'ebus open',
                value: function () { let n = 0; for (let val of self.requests.values()) { if (!val.response && !val.rejected) n++; } return n }
            });
            this.pm2_open_requests = pm2io.metric({
                name: 'ebus responded',
                value: function () { let n = 0; for (let val of self.requests.values()) { if (!!val.response) n++; } return n; }
            });
            this.pm2_open_requests = pm2io.metric({
                name: 'ebus rejected',
                value: function () { let n = 0; for (let val of self.requests.values()) { if (!!val.rejected) n++; } return n; }
            });
            this.pm2_open_requests = pm2io.metric({
                name: 'ebus total received',
                value: function () { return self.totalRequestCounts.received }
            });
            this.pm2_open_requests = pm2io.metric({
                name: 'ebus total responded',
                value: function () { return self.totalRequestCounts.responded }
            });
            this.pm2_open_requests = pm2io.metric({
                name: 'ebus total rejected',
                value: function () { return self.totalRequestCounts.rejected }
            });
        }

        this.log.setLevel(this.conf.debug)
    }

    start() {

        if (!this.waitingToReconnectSince) this.log.info(`worker for ${this.service} started with`, this.conf)
        else this.log.error(`reconnected after ${((new Date().valueOf()) - this.waitingToReconnectSince.valueOf()) / 1000}ms`);

        this._stop()
        this.started = true
        this.starts++
        
        if (this.pm2_starts_metric) {
            this.pm2_starts_metric.set(this.starts);
        }

        this.identity = 'W/' + this.service + '/' + uuid(),
        this.socket = zmq.socket('dealer')
        this.socket.identity = this.identity
        this.socket.setsockopt('linger', 1)
        this.socket.on('message', this._onMessage.bind(this))
        this.socket.on('error', this._onError.bind(this))
        this.socket.connect(this.conf.backend)
        this.liveness = consts.HEARTBEAT_LIVENESS_FOR_BROKER;

        if (this.conf.pub) {
            this.log.info('connecting pub', this.conf.pub)
            this.pub = zmq.socket('pub');
            this.pub.on('error', this._pubError.bind(this))
            this.pub.connect(this.conf.pub)
        }

        if (this.conf.sub) {
            this.log.info('connecting sub', this.conf.sub)
            this.sub = zmq.socket('sub')
            this.sub.on('error', this._subError.bind(this))
            this.sub.on('message', this._onNotification.bind(this))
            this.sub.connect(this.conf.sub)
            this.subscriptions.forEach(s => this.sub.subscribe(s.toString()))
            this.sub.subscribe('ebus');
        }

        this._sendReady()
        this._recvHeartbeat()
        this._sendHeartbeat()
        this._checkRequests()

        this.emit('start');
    }

    stop() {
        this._sendDisconnect()
        this._stop()
    }

    online() {
        return !!this.isonline;
    }

    on(evt, callback) {
        return super.on(evt, callback)
    }

    off(evt, callback) {
        return super.off(evt, callback)
    }

    emit(...args) {
        return super.emit(...args)
    }

    subscribe(channel) {
        channel = channel.toString()
        this.log.info('subscribe', channel)
        this.subscriptions.set(channel, channel)
        if (this.started) this.sub.subscribe(channel)
    }

    unsubscribe(channel) {
        channel = channel.toString()
        this.log.info('unsubscribe', channel)
        this.subscriptions.delete(channel)
        if (this.started) this.sub.unsubscribe(channel)
    }

    publish(channel, data) {
        if (!this.conf.pub) {
            this.emit('error', 'pub port not defined')
            this.log.error('pub port not defined')
            return
        }
        this.log.info('publish', channel.toString(), data)
        this.pub.send([channel.toString(), pack(data)])
    }

    /**
     * Respond to client request
     * @param {String} rid - request id worker is responding to
     * @param {any} data - data to return to the client
     */
    respond(rid, data) {
        var req = this.requests.get(rid)
        if (!req) {
            this.emit('error', `respond: request ${rid} does not exist`);
            return
        }
        req.response = data;
        this._sendReply(req)
        this.totalRequestCounts.responded++
    }

    /**
     * Reject client request
     * @param {String} rid - request id worker is rejecting
     * @param {*} data - rejection info to send to the client
     */
    reject(rid, data) {
        var req = this.requests.get(rid)
        if (!req) {
            this.emit('error', `reject: request ${rid} does not exist`);
            return
        }
        req.response = data;
        req.rejected = true
        this._sendReply(req)
        this.totalRequestCounts.rejected++
    }

    /** @private */
    _stop() {

        if (!this.started) return;
        this.started = false;

        this.log.info(`worker for ${this.service} stopping`)

        if (this.pub) {
            this.pub.close()
            delete this.pub
        }
        if (this.sub) {
            this.sub.close()
            delete this.sub
        }

        this._clearHeatbeatTimer()
        this._stopHeartbeat()
        this._clearRequestsTimer()
        if (!this.socket) return

        this.socket.close()
        delete this.socket

        this.emit('stop')
    }

    /** @private */
    _send(msg) {
        if (!this.socket) return;
        if (!this.readySent) return;
        this.socket.send(msg);
    }

    /** @private */
    _onError() {
        let err = [...arguments]
        this.emit('error', err)
    }

    /** @private */
    _onNotification(channel, data) {
        channel = (channel || '').toString()
        data = unpack(data);
        if (channel === consts.PUB_EBUS_SHUTDOWN) {
            this.log.info('server published shutdown')
            this.isonline = false;
            this.emit('offline');
        }
        this.log.info('rcvd broadcast', channel, data)
        this.emit('message', data, channel)
    }

    /** @private */
    _onMessage() {
        if (!this.readySent) {
            this.log.error('msg rcvd before READY sent')
            throw 'msg received before READY sent'
            return;
        }

        /** @type import('./sharedTypes').BrokerRequestToWorker  */
        let msg = [...arguments, null, null, null, null, null];

        //msg.forEach( (a,i) => console.log('> ',i,(a||'').toString()))

        var senderType = (msg[0] || '').toString();
        var messageType = (msg[1] || '').toString();
        var rid = (msg[2] || '').toString();
        var data = msg[3]
        var stales = parseInt((msg[4]||"").toString()) || this.conf.expiresMs

        
        if ([consts.PING, consts.HEARTBEAT].includes(messageType)) this.log.trace('rcvd msg', senderType, messageType)
        else this.log.debug('rcvd msg', senderType, messageType)

        if (messageType === consts.DISCONNECT) {
            this.log.info('rcvd DISCONNECT')
            this.start()
            return
        }

        this._gotHeartbeat();

        if (messageType === consts.HEARTBEAT) {
            return;
        }

        if (messageType === consts.PING) {
            this._send([consts.WORKER, consts.HEARTBEAT])
            return;
        }

        if (senderType !== consts.CLIENT) {
            this.log.error(`rcvd msg from ${senderType} instead of CLIENT`)
            this.emit('error', 'worker only accepts messages from clients ' + senderType + ' ' + messageType)
            return;
        }

        if (messageType === consts.CANCEL) {
            var cachedReq = this.requests.get(rid)
            if (cachedReq) {
                this.log.info("delete cancelled request",rid)
                this.emit('cancel', cachedReq)
                this.requests.delete(rid)
            }
            return;
        }

        if (messageType === consts.REQUEST) {
            data = unpack(data);
            var cachedReq = this.requests.get(rid)
            if (cachedReq) {
                cachedReq.receiveCount++;
                if (cachedReq.response) {
                    this._sendReply(cachedReq)
                }
                return;
            }

            this.log.info(`request`, rid, data)

            let expires = new Date();
            expires.setTime(expires.getTime() + stales);

            /** @type {WorkerRequest} */
            var req = {
                rid: rid,
                data: data,
                expires: expires,
                resend: 0,
                receiveCount: 1,
                response: null,
            };
            this.requests.set(rid, req);
            this.totalRequestCounts.received++

            this.emit('request', rid, data);
            return;
        }

        this.log.error('did not process msg', senderType, messageType, data)
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
    _sendReady() {
        this.log.debug('send READY to broker')
        this.socket.send([consts.WORKER, consts.READY, null, this.service])
        this.readySent = true;
    }

    /** @private */
    _sendDisconnect(why) {
        this.log.info('send disconnect', why)
        this._send([consts.WORKER, consts.DISCONNECT, this.service, why])
    }

    /** @private */
    _sendReply(req) {
        let json = null;
        this.log.info(`${req.rejected ? 'reject' : 'reply'}`, req.rid, req.response)
        if (req.response) json = pack(req.response);
        this._send([consts.WORKER, req.rejected ? consts.REJECT : consts.REPLY, req.rid, json])
        ++req.resend;
    }

    // heartheat to broker

    /** @private */
    _stopHeartbeat() {
        if (this.sendHeartbeatTimer) clearInterval(this.sendHeartbeatTimer);
        this.sendHeartbeatTimer = null;
    }

    /** @private */
    _sendHeartbeat() {
        if (!this.readySent) return;
        this._stopHeartbeat();
        this.sendHeartbeatTimer = setInterval(() => {
            this._send([consts.WORKER, consts.HEARTBEAT])
        }, this.conf.heartbeat)
    }

    // checking requests

    /** @private */
    _clearRequestsTimer() {
        if (this.reqTimer) clearInterval(this.reqTimer);
        this.reqTimer = null;
    }

    /** @private */
    _checkRequests() {
        this.reqTimer = setInterval(() => {
            this._removeExpiredResponses(new Date())
        }, this.conf.heartbeat)
    }


    /** @private */
    _removeExpiredResponses(now) {
        this.requests.forEach(req => {
            if (req.expires < now) {
                this.requests.delete(req.rid)
            }
        })
    }

    // inbound heartbeat

    /** @private */
    _recvHeartbeat() {
        if (this.brokerHeartbeatCheck) return;
        this.brokerHeartbeatCheck = setInterval(() => {
            if (this.liveness-- > 0) {
                this.log.debug('PING broker', this.liveness)
                this._send([consts.WORKER, consts.PING]);
            } else {

                if (this.isonline === true) {
                    this.isonline = false;
                    this.emit('offline');
                    this.log.error('missed heatbeats, restarting until reconnect')
                    this.waitingToReconnectSince = new Date()
                }

                this._sendDisconnect('missed heartbeats');
                this.start();
            }
            this._removeExpiredResponses();
        }, this.conf.heartbeat);
    }

    /** @private */
    _clearHeatbeatTimer() {
        if (this.brokerHeartbeatCheck) clearInterval(this.brokerHeartbeatCheck);
        this.brokerHeartbeatCheck = null;
    }

    /** @private */
    _gotHeartbeat() {
        this.log.debug('got HEARTBEAT', this.liveness)
        this._clearHeatbeatTimer()
        this.liveness = consts.HEARTBEAT_LIVENESS_FOR_BROKER;
        this._recvHeartbeat();

        if (this.isonline === false) {
            this.isonline = true;
            this.emit('online')
        }
    }

}

module.exports = Worker;