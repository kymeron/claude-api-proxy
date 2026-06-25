import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'events';
import {Writable} from 'stream';

import {routeFeedbackAdmin} from '../src/routes/feedback-admin.js';
import {listFeedbackForAdmin} from '../src/services/feedback.js';
import {Feedback} from '../src/db/models/feedback.js';

function makeReq(method, url, sessionUser, body = null) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = {host: '127.0.0.1'};
    req.socket = {remoteAddress: '127.0.0.1'};
    req.sessionUser = sessionUser;
    process.nextTick(() => {
        if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
    });
    return req;
}

function makeRes() {
    const chunks = [];
    const res = new Writable({
        write(chunk, encoding, callback) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            callback();
        }
    });
    res.status = null;
    res.headers = null;
    res.writeHead = function writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
    };
    const end = res.end.bind(res);
    res.end = function endWithBody(data = '') {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        return end();
    };
    Object.defineProperty(res, 'body', {
        get() {
            return Buffer.concat(chunks).toString('utf8');
        }
    });
    return res;
}

test('ordinary users only list their own feedback', async () => {
    const originalFindAndCountAll = Feedback.findAndCountAll;
    const calls = [];
    Feedback.findAndCountAll = async options => {
        calls.push(options);
        return {count: 0, rows: []};
    };

    try {
        await listFeedbackForAdmin({sessionUser: {username: 'alice', role: 'user'}});
        assert.equal(calls.at(-1).where.username, 'alice');

        await listFeedbackForAdmin({sessionUser: {username: 'root', role: 'superadmin'}});
        assert.equal(Object.hasOwn(calls.at(-1).where, 'username'), false);
    } finally {
        Feedback.findAndCountAll = originalFindAndCountAll;
    }
});

test('ordinary users can update and delete only their own feedback', async () => {
    const originalFindByPk = Feedback.findByPk;
    const owner = {id: 1, username: 'alice', attachments: [], async update(values) { this.values = values; }, async destroy() {}};
    const other = {id: 2, username: 'bob', attachments: [], async update(values) { this.values = values; }, async destroy() {}};
    Feedback.findByPk = async id => Number(id) === 1 ? owner : other;

    try {
        let res = makeRes();
        await routeFeedbackAdmin(
            makeReq('PUT', '/api/feedback/1/status', {username: 'alice', role: 'user'}, {status: 'processing'}),
            res
        );
        assert.equal(res.status, 200);

        res = makeRes();
        await routeFeedbackAdmin(
            makeReq('PUT', '/api/feedback/2/status', {username: 'alice', role: 'user'}, {status: 'processing'}),
            res
        );
        assert.equal(res.status, 403);

        res = makeRes();
        await routeFeedbackAdmin(
            makeReq('DELETE', '/api/feedback/2', {username: 'alice', role: 'user'}),
            res
        );
        assert.equal(res.status, 403);

        res = makeRes();
        await routeFeedbackAdmin(
            makeReq('DELETE', '/api/feedback/2', {username: 'admin', role: 'admin'}),
            res
        );
        assert.equal(res.status, 200);
    } finally {
        Feedback.findByPk = originalFindByPk;
    }
});

test('ordinary users cannot download other users feedback attachments', async () => {
    const originalFindByPk = Feedback.findByPk;
    Feedback.findByPk = async () => ({
        id: 2,
        username: 'bob',
        attachments: [{name: 'secret.txt', path: 'package.json'}]
    });

    try {
        const res = makeRes();
        await routeFeedbackAdmin(
            makeReq('GET', '/api/feedback/attachment/2/secret.txt', {username: 'alice', role: 'user'}),
            res
        );

        assert.equal(res.status, 403);
    } finally {
        Feedback.findByPk = originalFindByPk;
    }
});
