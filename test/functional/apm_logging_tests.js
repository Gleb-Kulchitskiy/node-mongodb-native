'use strict';

const fs = require('fs');
const stream = require('stream');
const setupDatabase = require('./shared').setupDatabase;
const chai = require('chai');
const expect = chai.expect;
const MongoClient = require('../..').MongoClient;
const EJSON = require('mongodb-extjson');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
chai.use(sinonChai);

const loggingEvents = [
  'commandStarted',
  'commandSucceeded',
  'commandFailed',
  'serverOpening',
  'serverDescriptionChanged',
  'serverHeartbeatStarted',
  'serverHeartbeatSucceeded',
  'serverHeartbeatFailed',
  'serverClosed',
  'topologyOpening',
  'topologyClosed',
  'topologyDescriptionChanged'
];

function stringify(obj) {
  return EJSON.stringify(obj, { relaxed: true });
}

function getLogData(logArray) {
  return logArray.reduce(
    (data, event) => {
      data.eventStrings.push(stringify(event.object));
      data[event.category].push(event);
      data.numLines += 1;
      return data;
    },
    { numLines: 0, command: [], sdam: [], eventStrings: [] }
  );
}

function runTestClient(context, urlOptions, closeCb) {
  const configuration = context.configuration;
  const url = configuration.url() + urlOptions;
  const client = new MongoClient(url, { w: 1, useNewUrlParser: true });
  const events = [];

  loggingEvents.forEach(event => client.on(event, e => events.push(stringify(e))));

  client.connect(function(err) {
    expect(err).to.be.null;
    client.close(err => {
      // set timeout to make sure all file writes are completed
      setTimeout(() => {
        const data = getLogData(fakeLogFile);
        closeCb(err, data, events);
      }, 10);
    });
  });
}

const testLogFileName = `${process.cwd()}/apm_test_log`;
const defaultFileName = `${process.cwd()}/monitor.log`;
const fakeLogFile = [];

describe('APM Logging', function() {
  let createStreamStub;

  before(function() {
    const fakeStream = new stream.Writable();
    // fake stream will 'write' data to our internal variable, fakeLogFile
    sinon.stub(fakeStream, 'write').callsFake(data => {
      fakeLogFile.push(EJSON.parse(data));
    });
    // avoid writing to file system & enable checking which file write streams are created on
    createStreamStub = sinon.stub(fs, 'createWriteStream').callsFake(() => {
      return fakeStream;
    });
    return setupDatabase(this.configuration);
  });

  beforeEach(function() {
    fakeLogFile.length = 0;
  });

  after(function() {
    createStreamStub.restore();
  });

  it('should append timestamp to a pre-existing log filename to avoid overwriting', function(done) {
    // suppress and spy on the renaming function
    const renameStub = sinon.stub(fs, 'renameSync');
    // trick the code into thinking log files already exist
    const existsStub = sinon.stub(fs, 'existsSync').callsFake(() => {
      return true;
    });
    const testStartStamp = new Date();
    const cb = err => {
      const renameArgs = renameStub.lastCall.args;
      const fileTimestamp = new Date(renameArgs[1].substring(renameArgs[1].length - 24));
      expect(renameArgs[0]).to.equal(testLogFileName);
      // ensure the date was appended to the file after this test started
      expect(fileTimestamp).to.be.above(testStartStamp);
      existsStub.restore();
      renameStub.restore();
      done(err);
    };
    runTestClient(this, '?monitor=command&monitorOut=apm_test_log', cb);
  });

  it('should create stream to default location if monitorOut not specified', function(done) {
    const cb = err => {
      expect(createStreamStub.lastCall).to.have.been.calledWith(defaultFileName);
      done(err);
    };
    runTestClient(this, '?monitor=command', cb);
  });

  it('should create stream to custom location if monitorOut specified', function(done) {
    const cb = err => {
      expect(createStreamStub.lastCall).to.have.been.calledWith(testLogFileName);
      done(err);
    };
    runTestClient(this, '?monitor=command&monitorOut=apm_test_log', cb);
  });

  it('should log to stdout if specified', function(done) {
    const spy = sinon.stub(process.stdout, 'write');
    const cb = err => {
      expect(spy).to.have.been.calledTwice;
      spy.restore();
      done(err);
    };
    runTestClient(this, '?monitor=command&monitorOut=stdout', cb);
  });

  it('should log to stderr if specified', function(done) {
    const spy = sinon.stub(process.stderr, 'write');
    const cb = err => {
      expect(spy).to.have.been.calledTwice;
      spy.restore();
      done(err);
    };
    runTestClient(this, '?monitor=command&monitorOut=stderr', cb);
  });

  it('should log correct event objects in the same order they were emitted', function(done) {
    const cb = (err, data, events) => {
      expect(events).to.deep.equal(data.eventStrings);
      done(err);
    };
    runTestClient(this, '?monitor=all&monitorOut=apm_test_log', cb);
  });

  it('log only sdam events', function(done) {
    const cb = (err, data) => {
      expect(data.numLines).to.equal(6);
      expect(data.command).to.be.empty;
      done(err);
    };
    runTestClient(this, '?monitor=sdam&monitorOut=apm_test_log', cb);
  });

  it('log only command events', function(done) {
    const cb = (err, data) => {
      expect(data.numLines).to.equal(2);
      expect(data.sdam).to.be.empty;
      done(err);
    };
    runTestClient(this, '?monitor=command&monitorOut=apm_test_log', cb);
  });

  // skip for now: this test depends on the new fixes in the core uri parser
  it.skip('log both command and sdam events using `monitor=command,sdam`', function(done) {
    const cb = (err, data) => {
      expect(data.numLines).to.equal(8);
      expect(data.sdam).to.not.be.empty;
      expect(data.command).to.not.be.empty;
      done(err);
    };
    runTestClient(this, '?monitor=command,sdam&monitorOut=apm_test_log', cb);
  });

  it('log both command and sdam events using `monitor=all`', function(done) {
    const cb = (err, data) => {
      expect(data.numLines).to.equal(8);
      expect(data.sdam).to.not.be.empty;
      expect(data.command).to.not.be.empty;
      done(err);
    };
    runTestClient(this, '?monitor=all&monitorOut=apm_test_log', cb);
  });

  it('should call callback with error when log filename cannot be resolved', function(done) {
    const configuration = this.configuration;
    const url = configuration.url() + '?monitor=all&monitorOut=invalid:name';
    const client = new MongoClient(url, { w: 1, useNewUrlParser: true });

    client.connect(function(err) {
      expect(err).to.exist;
      expect(err).to.be.an.instanceOf(TypeError);
      done();
    });
  });

  // TODO: how to test throwing errors if we don't know exactly when the error will be thrown?
  it.skip('should throw error when file stream emits error after client has connected', function(done) {
    const configuration = this.configuration;
    const url = configuration.url() + '?monitor=all&monitorOut=nonexistent/file/path';
    const client = new MongoClient(url, { w: 1, useNewUrlParser: true });

    client.connect(() => done());
  });
});