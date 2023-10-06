//@ts-check

'use strict';

const modules = ['EBUS', 'EBUS_BROKER']
const zmq = require('zeromq');
const { v1: uuid } = require('uuid');
const events = require('events');
const consts = require('./consts');

import * as chs from 'cry-helpers';
const Log = chs.Log;
//const Log = require('cry-helpers').Log;
const log = new Log(modules);
const envconf = require('cry-helpers').getConf;
const dotenv = require('dotenv')
const dotenvExpand = require('dotenv-expand')
const { pack, unpack } = require('./serialize');
const { throws } = require('assert');
let pm2io = null

/**
 * @typedef WorkerEntry
 * @property {String} identity - workerIdentity,
 * @property {String} service - service,
 * @property {Date} heartbeatExpires - expires,
 * @property {Number} liveness - this.conf.liveness,
 * @property {Number} load - 0
* @property {any} [pm2metric] - pm2 metric for this worker
* @property {String} name - friendly worker name
 */

/**
 * @typedef BrokerRequest
 * @property {String} clientIdentity - clientIdentity,
 * @property {String} rid - rid,
 * @property {String} service - service,
 * @property {any} data - data,
 * @property {Date} expires - expires,
 * @property {Date} resend - 0,
 * @property {Number} receiveCount - 1,
 * @property {any} response - undefined, // null represens actual data passed in
 * @property {String} sentToWorkerId - null,
 * @property {Date} cacheExpires - cacheExpires,
 * @property {Number} stalesMs - when the request is rejected if not answered by a worker
 * @property {Number} resendMs - resend this request after that many ms
 * @property {Number} cacheForMs - for how many ms should we cache the request
 * @property {Boolean} [rejected] - true if this request was rejected
 */

/**
 * @typedef BrokerConfig
* @property {String} [server] - default 'tcp://*',
* @property {String} [frontend] - default '[SERVER]:' + consts.FRONTEND,
* @property {String} [backend] - default '[SERVER]:' + consts.BACKEND,
* @property {String} [pub] - default '[SERVER]:' + consts.PUB,
* @property {String} [sub] - default '[SERVER]:' + consts.SUB,
* @property {Number} [heartbeat] - default consts.HEARTBEATMS,
* @property {Number} [liveness] - default consts.HEARTBEAT_LIVENESS_FOR_WORKER,
* @property {Number} [expire] - ms till requests exipre - default consts.EXPIRERQMS,
* @property {Number} [resubmitEvery] - default 3,
* @property {String} [uid] - default 'B' + uuid(),
* @property {Number} [debug] - default log.level.ERROR
* @property {Number} [resendMs] - consts.RESENDRQMS
* @property {Number} [resendX] - consts.RESENDRQMX
* @property {Boolean} [reportLoad] - process.env.EBUS_BROKER_REPORT_LOAD
* @property {Boolean} [reportToPm2] - true
 */

let workerCounts = {}

// @ts-ignore
class Broker extends events {

    /**
     * 
     * @param {BrokerConfig} config 
     */
    constructor(config) {

        super()

        dotenvExpand(dotenv.config());

        /** @type {BrokerConfig} */
        let defaults = {
            server: 'tcp://*',
            frontend: '[SERVER]:' + consts.FRONTEND,
            backend: '[SERVER]:' + consts.BACKEND,
            pub: '[SERVER]:' + consts.PUB,
            sub: '[SERVER]:' + consts.SUB,
            heartbeat: consts.HEARTBEATMS,
            liveness: consts.HEARTBEAT_LIVENESS_FOR_WORKER,
            expire: consts.EXPIRERQMS,
            resubmitEvery: 3,
            uid: 'B' + uuid(),
            debug: log.level.ERROR,
            resendMs: consts.RESENDRQMS,
            resendX: consts.RESENDRQX,
            reportLoad: !!process.env.EBUS_BROKER_REPORT_LOAD,
            reportToPm2: true,
        }

        /** @type {BrokerConfig} */
        this.conf = envconf(modules, defaults, config);

        if (this.conf.frontend.startsWith('[SERVER]')) this.conf.frontend = this.conf.frontend.replace('[SERVER]', this.conf.server);
        if (this.conf.backend.startsWith('[SERVER]')) this.conf.backend = this.conf.backend.replace('[SERVER]', this.conf.server);
        if (this.conf.pub.startsWith('[SERVER]')) this.conf.pub = this.conf.pub.replace('[SERVER]', this.conf.server);
        if (this.conf.sub.startsWith('[SERVER]')) this.conf.sub = this.conf.sub.replace('[SERVER]', this.conf.server);

        this.started = false

        this.hbTimer = null
        this.reqTimer = null

        /** @type {Map<string,WorkerEntry>}  */
        this.workers = new Map()

        /** @type {Map<string,BrokerRequest>} */
        this.requests = new Map()
        log.setLevel(this.conf.debug)
        
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
                name: 'ebus cached responded',
                value: function () { let n = 0; for (let val of self.requests.values()) { if (!!val.response) n++; } return n; }
            });
            this.pm2_open_requests = pm2io.metric({
                name: 'ebus cached rejected',
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
    }

    start() {

        log.info('broker starting with config ', this.conf)

        this.stop();
        this.started = true;

        this.conf.uid = 'B' + uuid();
        this.backend = zmq.socket('router');
        this.backend.identity = new Buffer(this.conf.uid);
        this.backend.setsockopt('linger', 1);
        this.backend.on('message', this._onBackendMessage.bind(this));
        this.backend.on('error', this._onBackendError.bind(this))
        this.backend.bindSync(this.conf.backend)

        this.frontend = zmq.socket('router');
        this.frontend.identity = new Buffer(this.conf.uid);
        this.frontend.setsockopt('linger', 1);
        this.frontend.on('message', this._onFrontendMessage.bind(this));
        this.frontend.on('error', this._onFrontendError.bind(this))
        this.frontend.bindSync(this.conf.frontend)

        this.sub = zmq.socket('xsub')
        this.sub.identity = 'sub' + this.conf.uid
        this.sub.on('message', this._onSub.bind(this))
        this.sub.on('error', this._subError.bind(this))
        this.sub.bindSync(this.conf.pub) // not a mistake

        this.pub = zmq.socket('xpub');
        this.pub.identity = 'pub' + this.conf.uid;
        this.pub.setsockopt(zmq.ZMQ_SNDHWM, consts.PUBHWM);
        this.pub.setsockopt(zmq.ZMQ_XPUB_VERBOSE, 0);
        this.pub.on('message', this._onPub.bind(this))
        this.pub.on('error', this._pubError.bind(this))
        this.pub.bindSync(this.conf.sub); // not a mistake

        this._checkHeartbeat()
        this._checkRequests()

        this.emit('start');

        if (this.pub) {
            this._publishBrokerStatus(consts.PUB_EBUS_STARTED, { ebusmessage: 'broker starting' })
        }
    }

    stop() {

        if (!this.started) return
        this.started = false;

        this._clearHeatbeatTimer()
        this._clearRequestsTimer()

        if (this.pub) {
            this._publishBrokerStatus(consts.PUB_EBUS_SHUTDOWN, { ebusmessage: 'broker stopping' })
        }

        log.info('broker stopping')



        this.workers.forEach(w => {
            this._disconnectWorker(w.identity, 'broker is stopping')
        })

        if (this.frontend) {
            this.frontend.close()
            delete this.frontend
        }
        if (this.backend) {
            this.backend.close()
            delete this.backend
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

    on(...args) {
        super.on(...args)
    }
    off(...args) {
        super.off(...args)
    }
    emit(...args) {
        super.emit(...args)
    }

    setLogLevel(n) {
        console.log('set log level', n)
        log.setLevel(n)
    }

    getWorkers() {
        let ws = []
        this.workers.forEach(w => ws.push({ id: w.identity, service: w.service, load: w.load }))
        return ws;
    }

    getConfig() {
        return JSON.parse(JSON.stringify(this.conf))
    }

    _onSub(channel, data) {
        log.info('XSUB to publish', channel.toString())
        this.pub.send([channel, data])
    }

    _onPub(data) {
        var type = data[0] === 0 ? 'unsubscribe' : 'subscribe';
        var channel = data.slice(1).toString();
        log.info(`XPUB`, type + ':' + channel);
        this.sub.send(data);
    }

    _subError(err) {
        log.error('sub error', err)
        this.emit('error', err, 'sub')
    }

    _pubError(err) {
        log.error('pub error', err)
        this.emit('error', err, 'pub')
    }

    _sendToFrontend(msg) {
        log.trace('to frontend ', msg)
        this.frontend.send(msg);
    }

    _sendToBackend(msg) {
        log.trace('to backend ', msg)
        this.backend.send(msg);
    }

    _onFrontendError(err) {
        log.error('frontend error', err);
        this.emit('error', err, 'frontend');
    }

    _onBackendError(err) {
        log.error('backend error', err);
        this.emit('error', err, 'backend');
    }

    _onFrontendMessage() {

        let msg = [...arguments, null, null, null, null, null, null];

        let clientIdentity = (msg[0] || '').toString();
        let empty = (msg[1] || '').toString();
        let senderType = (msg[2] || '').toString();
        let messageType = (msg[3] || '').toString();
        let service = (msg[4] || '').toString();
        let rid = (msg[5] || '').toString();
        let data = msg[6];
        let stalesMs = parseInt((msg[7]||'').toString())

        if ([consts.PING, consts.HEARTBEAT].includes(messageType)) log.trace('rcvd frontend msg', senderType, messageType, service, clientIdentity, data)
        else log.debug('rcvd frontend msg', senderType, messageType, service, clientIdentity)

        if (senderType !== consts.CLIENT) {
            this._sendToFrontend([clientIdentity.toString(), '', consts.WORKER, consts.DISCONNECT, 'must be a client to talk to frontend ' + senderType + ' ' + messageType])
            return;
        }

        if (messageType === consts.PING) {
            this._sendToFrontend([clientIdentity.toString(), '', consts.WORKER, consts.HEARTBEAT])
            return;
        }

        if (messageType === consts.CANCEL) {
            let req = this.requests.get(rid)
            if (req && req.sentToWorkerId && req.clientIdentity ===clientIdentity && req.response===undefined) {
                log.info('removing message cancelled by the client ', req.service, req.rid)
                this._sendToBackend([req.sentToWorkerId, consts.CLIENT, consts.CANCEL, req.rid])
            }
            this.requests.delete(rid)
            return;
        }

        if (messageType === consts.REJECT) {
            let req = this.requests.get(rid)
            if (req && req.sentToWorkerId && req.clientIdentity === clientIdentity && req.response === undefined) {
                log.info('removing message rejected by the client ', req.service, req.rid)
                this._sendToBackend([req.sentToWorkerId, consts.CLIENT, consts.CANCEL, req.rid])
            } 
            this.requests.delete(rid)
            return;
        }

        if (messageType === consts.DISCONNECT) {
            this.requests.forEach(req => {
                if (req.clientIdentity === clientIdentity && req.response === undefined) {
                    log.info('removing message of disconnecting client ', req.service, req.rid)
                    this._sendToBackend([req.sentToWorkerId, consts.CLIENT, consts.CANCEL, req.rid])
                }
            });
            return;
        }

        if (messageType === consts.SERVICES) {
            // return services available
            let services = new Map()
            this.workers.forEach(w => services.set(w.service, ''))
            let arr = Array.from(services.keys())
            this._sendToFrontend([clientIdentity.toString(), '', consts.WORKER, consts.SERVICES, rid, pack(arr)])
            return;
        }

        if (messageType === consts.WORKERS) {
            // return services available
            let ret = []
            this.workers.forEach(w => ret.push({ id: w.identity, service: w.service, load: w.load }))
            ret.sort((a, b) => a.service.localeCompare(b.service));
            this._sendToFrontend([clientIdentity.toString(), '', consts.WORKER, consts.WORKERS, rid, pack(ret)])
            return;
        }

        if (messageType === consts.REQUEST) {

            // see if we have this response cached
            let reqcached = this.requests.get(rid);
            if (reqcached) {
                reqcached.receiveCount++;
                if (reqcached.response !== undefined) {
                    log.debug('reply from cache', rid, reqcached.response)
                    this._sendToFrontend([clientIdentity.toString(), '', consts.WORKER, consts.REPLY, rid, reqcached.response])
                }
                return;
            }

            log.info("client request", service, unpack(data))

            let resendMs = Math.max(this.conf.resendMs, stalesMs * this.conf.resendX);
            let resend = new Date()
            resend.setTime(resend.getTime() + resendMs)
            stalesMs = stalesMs || this.conf.expire;
            let expires = new Date();
            expires.setTime(expires.getTime() + stalesMs);
            let cacheForMs = Math.max(consts.CACHERQMS, consts.CACHERQX * stalesMs);
            let cacheExpires = new Date();
            cacheExpires.setTime(cacheExpires.getTime() + cacheForMs);

            /** @type BrokerRequest */
            var req = {
                clientIdentity,
                rid,
                service,
                data,
                expires,
                receiveCount: 1,
                response: undefined, // null represend actual data passed in
                sentToWorkerId: null,
                cacheExpires,
                stalesMs,
                resendMs,
                resend,
                cacheForMs,
            };
            this.requests.set(req.rid, req);
            this.totalRequestCounts.received++;

            this._distributeWork()

            this.emit('request', service, rid, unpack(data))
            return;
        }

        log.error(`did not process frontend message`, senderType, messageType, service, rid, data)
    }

    _onBackendMessage() {

        let msg = [...arguments, null, null, null, null, null];

        let workerIdentity = (msg[0] || '').toString();
        let senderType = (msg[1] || '').toString();
        let messageType = (msg[2] || '').toString();
        let rid = (msg[3] || '').toString();
        let data = msg[4];

        //msg.forEach( (a,i) => console.log('> ',i,(a||'').toString()))


        if (["PING","HEARTBEAT"].includes(messageType)) log.trace('rcv backend msg', senderType, messageType, workerIdentity)
        else log.debug('rcv backend msg', senderType, messageType, workerIdentity)

        if (senderType !== consts.WORKER) {
            log.error(`rcvd backend msg from ${senderType} instead of WORKER`)
            this._disconnectWorker(workerIdentity, 'wrong senderType ' + senderType)
            this._publishWorkers();
            return;
        }

        let expires = new Date()
        expires.setTime(expires.getTime() + this.conf.heartbeat)

        if (messageType === consts.READY) {

            let service = data.toString()
            if (!service) return;

            /** @type WorkerEntry */
            let worker = this.workers.get(workerIdentity);
            if (worker) {
                log.error(`worker ${workerIdentity} sent READY twice and will be disconnected`)
                this._disconnectWorker(workerIdentity, 'got second READY');
                this._publishWorkers();
                return
            }

            workerCounts[service] = (workerCounts[service] || 0) + 1;

            worker = {
                identity: workerIdentity,
                service: service,
                heartbeatExpires: expires,
                liveness: this.conf.liveness,
                load: 0,
                name: `${service} ${workerCounts[service]}`,
            }
            this.workers.set(workerIdentity, worker);
            log.info(`new worker for ${service}: ${workerIdentity}`)
            this.emit('new worker', service, workerIdentity)
            this._publishWorkers();

            this._distributeWork();

            return;
        }

        // if worker is not registered, it didnt set READY and must disconnect
        let worker = this.workers.get(workerIdentity);
        if (!worker) {
            log.error(`worker ${workerIdentity} sent a message before READY`)
            this._disconnectWorker(workerIdentity, 'must send READY first');
            return
        }

        worker.heartbeatExpires = expires
        worker.liveness = this.conf.liveness

        if (messageType === consts.HEARTBEAT) {
            return;
        }

        if (messageType === consts.DISCONNECT) {
            log.info('worked disconnected itself', workerIdentity);
            // reasign work
            let reasigned=0
            this.requests.forEach(req => {
                if (req.sentToWorkerId === workerIdentity) {
                    reasigned++
                    delete req.sentToWorkerId
                }
            })
            this.workers.delete(workerIdentity);
            if (reasigned) this._distributeWork()
            this._publishWorkers();
            return
        }

        if (messageType === consts.PING) {
            this._sendToBackend([workerIdentity.toString(), consts.CLIENT, consts.HEARTBEAT])
            return;
        }

        if (messageType === consts.REJECT) {
            var req = this.requests.get(rid)
            if (!req) return;

            req.sentToWorkerId = undefined
            req.rejected = true
            req.response = data

            this._sendToFrontend([req.clientIdentity.toString(), '', consts.WORKER, consts.REJECT, rid, data])
            this.emit('reject', worker.service, rid, data)

            this._changeWorkerLoad(worker, -1)
            this.totalRequestCounts.rejected++

            return;
        }

        if (messageType === consts.REPLY) {
            var req = this.requests.get(rid);
            if (!req) return;

            req.response = data;
            log.info('worker replied', unpack(data))
            this._sendToFrontend([req.clientIdentity.toString(), '', consts.WORKER, consts.REPLY, rid, data])
            this.emit('reply', worker.service, rid, data)

            this._changeWorkerLoad(worker, -1)
            this.totalRequestCounts.responded++

            return;
        }

        log.error('did not process backend message', senderType, messageType, rid, data)

        return;
    }

    _disconnectWorker(workerIdentity, reason) {
        this._sendToBackend([workerIdentity.toString(), consts.CLIENT, consts.DISCONNECT, reason])
        this.workers.delete(workerIdentity)
        this.requests.forEach(req => {
            if (req.sentToWorkerId === workerIdentity) {
                req.sentToWorkerId == null;
            }
        })
        this.emit('disconnect worker', workerIdentity)
    }

    _clearHeatbeatTimer() {
        clearInterval(this.hbTimer);
        this.hbTimer = null;
    }

    _clearRequestsTimer() {
        clearInterval(this.reqTimer);
        this.reqTimer = null;
    }

    _checkRequests() {
        if (this.reqTimer) return;
        this.reqTimer = setInterval(() => {
            var now = new Date()
            this.requests.forEach(req => {
                if (req.expires < now) {
                    if (req.response === undefined) {
                        log.error('request expired', req)
                        this._sendToFrontend([req.clientIdentity, '', consts.WORKER, consts.REJECT, req.rid])
                        this.emit('expired', req.rid)
                        if (req.sentToWorkerId) {
                            var w = this.workers.get(req.sentToWorkerId)
                            if (w) {
                                this._changeWorkerLoad(w, -1);
                            }
                        }
                        this.requests.delete(req.rid)
                    }
                }
                if (req.cacheExpires < now) {
                    if (req.response !== undefined) {
                        this.requests.delete(req.rid)
                    }
                }
            })
            this._distributeWork()
        }, this.conf.heartbeat * this.conf.resubmitEvery)
    }

    _distributeWork() {
        let now = new Date()
        this.requests.forEach(req => {
            if (req.response === undefined && (!req.sentToWorkerId || (req.resend && req.resend < now))) {
                // find worker for this service with minimal load
                /** @type {WorkerEntry} */
                let worker = null;
                let minLoad = consts.MAXWORKERLOAD + 1000;
                this.workers.forEach(w => {
                    if (w.service === req.service && w.load < minLoad) {
                        worker = w;
                        minLoad = w.load;
                    }
                })

                if (worker) {
                    log.debug(`submit request to worker for ${worker.service} loaded ${worker.load}`, worker.identity)
                    this._changeWorkerLoad(worker, 1)
                    req.sentToWorkerId = worker.identity
                    let resend = new Date();
                    resend.setTime(resend.getTime() + req.resendMs);
                    req.resend = resend;
                    this._sendToBackend([worker.identity.toString(), consts.CLIENT, consts.REQUEST, req.rid, req.data, req.stalesMs])
                } else {
                    log.debug(`no worker for service ${req.service} for request ${req.rid}`)
                }
            }
        })
    }


    /**
     * 
     * @param {WorkerEntry} worker 
     * @param {Number} change 
     */
    _changeWorkerLoad(worker, change) {

        worker.load += change;

        if (!!this.conf.reportToPm2) {
            if (!worker.pm2metric) worker.pm2metric = pm2io.metric({ name: "ebus " + worker.name + " current load" })
            worker.pm2metric.set(worker.load);
        }

        if (!this.conf.reportLoad) return;
        console.log("load", worker.identity, worker.service, worker.load);
    }

    _checkHeartbeat() {
        
        if (this.hbTimer) return;
        this.hbTimer = setInterval(() => {
            let now = new Date()
            this.workers.forEach((worker) => {
                if (worker.heartbeatExpires < now) {
                    if (worker.liveness-- > 0) {
                        log.trace('PING worker', worker.identity, worker.liveness + 1)
                        this._sendToBackend([worker.identity.toString(), consts.CLIENT, consts.PING])
                    } else {
                        log.debug('missed heartbeat from worker', worker.identity)
                        this._disconnectWorker(worker.identity, 'no heartbeat')
                        this._publishWorkers();
                    }
                }
            });
        }, this.conf.heartbeat * 2);
    }

    _publishWorkers() {
        if (this.pub) {
            let ret = new Set()
            this.workers.forEach(w => { ret.add(w.service) })
            let reta = Array.from(ret).sort();

            this._publishBrokerStatus(consts.PUB_WORKERS_CHANNEL, { ebusmessage: 'active workers', workers: reta })
        }
    }

    _publishBrokerStatus(channel, data) {
        this.pub.send([channel, pack(data)]);
    }
}

module.exports = Broker;