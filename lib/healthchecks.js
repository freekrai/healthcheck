'use strict';

var assert     = require('assert');
var debug      = require('debug')('healthchecks');
var File       = require('fs');
var Handlebars = require('handlebars');
var hrTime     = require('pretty-hrtime');
var HTTP       = require('http');
var ms         = require('ms');
var Path       = require('path');
var URL        = require('url');
var reqget    = require('request');

// Default timeout for checks; a slow server is a failed server.
var DEFAULT_TIMEOUT = '3s';

// HTTP status codes which we follow as redirects.
var REDIRECT_STATUSES = [301, 302, 303, 307];

// The maximum amount of redirects we will follow.
var MAX_REDIRECT_COUNT = 10;


// Represents a check outcome with the properties url, reason, etc.
//
// url        - Checked URL
// elapsed    - In milliseconds
// error      - Protocol error
// statusCode - HTTP status code
// body       - Response body
// expected   - Expected response body (array)
function Outcome(args) {
  this.url      = args.url;
  this.elapsed  = hrTime(args.elapsed);
  if (args.error && args.error.code === 'ETIMEDOUT') {
    this.reason   = 'timeout';
    this.timeout  = true;
  } else if (args.error) {
    this.reason   = 'error';
    this.error    = args.error;
  } else {

    this.statusCode = args.statusCode;
    this.body       = args.body;
    if (this.statusCode < 200 || this.statusCode >= 400)
      this.reason   = 'statusCode';
    else {

      var expected    = args.expected;
      var allMatching = expected.every(text => ~args.body.indexOf(text));
      if (!allMatching)
        this.reason = 'body';

    }
  }
  this.log();
}


// Log outcome, visible when DEBUG=healthchecks
Outcome.prototype.log = function() {
  switch (this.reason) {
    case 'error': {
      debug('%s: Server responded with error %s', this.url, this.error);
      break;
    }
    case 'timeout': {
      debug('%s: Server response timeout', this.url);
      break;
    }
    case 'statusCode': {
      break;
    }
    case 'body': {
      debug('%s: Server response did not contain expected text', this.url);
      break;
    }
    // no default
  }
};


// Easy way to log check outcome, shows the URL and the reason check failed
Outcome.prototype.toString = function() {
  switch (this.reason) {
    case 'error': {
      return `${this.url} => ${this.error.message}`;
    }
    case 'statusCode': {
      return `${this.url} => ${this.statusCode}`;
    }
    case undefined: {
      debug('%s: Server responded with status code %s', this.url, this.statusCode);
      return this.url;
    }
    default: {
      return `${this.url} => ${this.reason}`;
    }
  }
};


// Our Handlerbars instance.
var handlebars = Handlebars.create();


// Checks the status of the given relative URL.
// This URL, and all possible redirects, are resolved using
// the resolver function.
function runCheck(args) {
  var url       = args.url;
  var headers   = args.headers;
  var resolver  = args.resolver;
  var timeout   = args.timeout;
  var redirects = args.redirects || 0;
  var loopbackURL = resolver(url);
  var request     = {
    host:     loopbackURL.host,
    port:     loopbackURL.port,
    path:     loopbackURL.path,
    headers:  Object.assign({}, headers, {
      'Host':              loopbackURL.hostname,
      'X-Forwarded-Proto': loopbackURL.protocol.replace(/:$/, '')
    })
  };

  return get(url, request, timeout)
    .then(function(response) {
      var isRedirect = ~REDIRECT_STATUSES.indexOf(response.statusCode);
      if (isRedirect) {

        var redirectLoop = redirects >= MAX_REDIRECT_COUNT;
        if (redirectLoop)
          throw new Error('too many redirects');
        else {
          var redirectURL = response.headers.location;
          var sameDomain  = withinSameDomain(resolver(redirectURL), loopbackURL);
          if (sameDomain)
            return runCheck({ url: redirectURL, headers, resolver, timeout, redirects: redirects + 1 });
          else
            return response;
        }

      } else
        return response;
    });
}


// Makes an promisified HTTP GET request.
//
// On success, promise is resolved with { statusCode, headers, body }.
// On error or timeout, promise is rejected with error.
//
function get(url, request, timeout) {
  return new Promise(function(resolve, reject) {
	  reqget.get(url, function (error, res, body) {
	    if (error){
	      reject(error)
	  	}else{
			resolve({
              statusCode: res.statusCode,
              headers:    res.headers,
              body:       body
            });
		}
	  });
/*
//	no longer used..... keeping just for history, will remove later.
    HTTP.get(request)
      .on('error', reject)
      .on('response', function(response) {
        var buffers = [];
        response.on('data', function(buffer) {
          buffers.push(buffer);
        });
        response.on('end', function() {
          var body = Buffer.concat(buffers).toString();
          resolve({
            statusCode: response.statusCode,
            headers:    response.headers,
            body:       body
          });
        });
      });
*/
    setTimeout(function() {
      var error = new Error('ETIMEDOUT');
      error.code  = 'ETIMEDOUT';
      reject(error);
    }, timeout);
  });
}


function withinSameDomain(from, to) {
  var fromHost = from.hostname;
  var toHost   = to.hostname;
  return fromHost === toHost ||
         fromHost.endsWith(`.${toHost}`) ||
         toHost.endsWith(`.${fromHost}`);
}


// The check function will run all checks in parallel, and resolve to an object
// with the properties:
// passed  - A list of all check URLs that passed
// failed  - A list of all check URLs that failed
function checkFunction(url, requestID) {
  var protocol = URL.parse(url).protocol;
  var hostname = URL.parse(url).hostname;
  var port     = URL.parse(url).port;

  var checks  = this.checks;
  var timeout = this.timeout;

  // Given a relative URL in string form, returns a parsed URL
  // which points to the local server's IP address and port
  // and has the right hostname property to use in the Host header.
  function loopbackResolve(relativeURL) {
    var absoluteURL = URL.parse(URL.resolve(`${protocol}//localhost/`, relativeURL));
    var loopbackURL = Object.assign({}, absoluteURL, {
      hostname: absoluteURL.hostname,
      host:     hostname,
      port:     port
    });
    return loopbackURL;
  }

  // Each check resolves into an outcome object
  var allChecks = Object.keys(checks).map(function(checkURL) {
    var expected = checks[checkURL];

    // We need to make an HTTP/S request to the current server,
    // based on the hostname/port passed to us,
    // so the HTTP check would go to http://localhost:80/ or some such URL.
    var headers = {
      'User-Agent':   'Mozilla/5.0 (compatible) Healthchecks https://clevertech.biz',
      'X-Request-Id': requestID || ''
    };

    var start = process.hrtime();
    return runCheck({ url: checkURL, headers, resolver: loopbackResolve, timeout })
      .then(function(response) {
        var elapsed = process.hrtime(start);
        var outcome = new Outcome({ url: checkURL, expected, statusCode: response.statusCode, body: response.body, elapsed });
        return outcome;
      })
      .catch(function(error) {
        var elapsed = process.hrtime(start);
        var outcome = new Outcome({ url: checkURL, expected, error, elapsed });
        return outcome;
      });
  });


  // Run all checks in parallel
  var allOutcomes = Promise.all(allChecks);

  // Reduce into an object with the passed and failed lists of URLs
  var passedAndFailed = allOutcomes
    .then(function(outcomes) {
      return {
        passed: outcomes.filter(outcome => !outcome.reason ),
        failed: outcomes.filter(outcome => outcome.reason )
      };
    });

  // Returns the promise
  return passedAndFailed;
}


// Read the checks file and returns a check function (see checkFunction).
function readChecks(filename, timeout) {
  var checks = File.readFileSync(filename, 'utf-8')
    .split(/[\n\r]+/)                     // Split into lines
    .map(line => line.trim())             // Ignore leading/trailing spaces
    .filter(line => line.length)          // Ignore empty lines
    .filter(line => line[0] !== '#')      // Ignore comments
    .filter(line => !/^\w+=/.test(line))  // Ignore name = value pairs
    .map(function(line) {             // Split line to URL + expected value
      var match = line.match(/^(\S+)\s*(.*)/);
      return {
        url:      match[1],
        expected: match[2]
      };
    })
    .map(function(check) {            // Valid URLs only
      // URLs may be relative to the server, so contain an absolute path
      var url = URL.parse(check.url);
      assert(url.pathname && url.pathname[0] === '/', 'Check URL must have absolute pathname');
      assert(!url.protocol || /^https?:$/.test(url.protocol), 'Check URL may only use HTTP/S protocol');
      return check;
    })
    .reduce(function(memo, check) {
      var url = check.url;
      memo[url] = memo[url] || []; // eslint-disable-line
      if (check.expected)
        memo[url].push(check.expected);
      return memo;
    }, {});

  // Returns a check function that will use these checks / settings
  var context = {
    checks:   checks,
    timeout:  timeout
  };
  debug('Added %d checks', checks.length);

  return checkFunction.bind(context);
}


// Returns a comparer function suitable for Array.sort().
function compareProperty(propName) {
  return function(a, b) {
    if (a[propName] < b[propName])
      return -1;
    if (a[propName] > b[propName])
      return 1;
    return 0;
  };
}


// Respond with 200 only if all checks passed
// Respond with 500 if any check fail
// Respond with 404 if there are no checks to run
function statusCodeFromOutcomes(passed, failed) {
  var anyFailed = failed.length > 0;
  var anyPassed = passed.length > 0;
  if (anyFailed)
    return 500;
  else if (anyPassed)
    return 200;
  else
    return 404;
}


// Call this function to configure and return the middleware.
module.exports = function healthchecks(options) {
  assert(options, 'Missing options');

  // Pass filename as first argument or named option
  var filename    = typeof (options) === 'string' ? options : options.filename;
  assert(filename, 'Missing checks filename');

  // Pass timeout as named option, or use default
  var timeoutArg  = (typeof (options) === 'object' && options.timeout) || DEFAULT_TIMEOUT;
  // If timeout argument is a string (e.g. "3d"), convert to milliseconds
  var timeout     = (typeof (timeoutArg) === 'string') ? ms(timeoutArg) : parseInt(timeoutArg, 10);

  var onFailed    = options.onFailed || function() {};

  // Read all checks form the file and returns a checking function
  var runChecks   = readChecks(filename, timeout);

  // Load Handlebars template for rendering results
  var template    = File.readFileSync(Path.join(__dirname, '/index.hbs'), 'utf-8');
  var render      = handlebars.compile(template);


  // Return the Express middleware
  return function(req, res) {

    var requestID = req.headers['x-request-id'];

    // We use local address/port to health check this server, e.g. the checks
    // may say //www.example.com/ but in development we connect to
    // 127.0.0.1:5000
    var protocol  = req.socket.encrypted ? 'https:' : 'http:';
    var hostname  = req.socket.localAddress;
    var port      = req.socket.localPort;
    var url       = URL.format({ protocol, hostname, port });

    // Run all checks
    debug('Running against %s://%s:%d with request-ID %s', protocol, hostname, port, requestID);
    runChecks(url, requestID)
      .then(function(outcomes) {
        debug('%d passed and %d failed', outcomes.passed.length, outcomes.failed.length);

        var passed      = outcomes.passed.sort(compareProperty('url'));
        var failed      = outcomes.failed.sort(compareProperty('url'));
        var statusCode  = statusCodeFromOutcomes(passed, failed);

        var html        = render({ passed, failed });
        res.writeHeader(statusCode);
        res.write(html);
        res.end();

        if (failed.length > 0)
          onFailed(failed);
      });
  };

};
