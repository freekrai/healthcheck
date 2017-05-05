var healthchecks = require('./lib/healthchecks');
var mongojs = require('mongojs');

var fooStatus = require('redis-status')({
	name: 'redis',
	port: 6379,
	host: 'localhost'
});

var app = require('gopher');

app.set('port', 3012);

app.get('/', function(request, response) {
    response.send('hello world!');
});

app.use('/healthcheck', healthchecks({
	filename:   __dirname + '/checks',
	timeout:    '5s',    // 5 seconds, can also pass duration in milliseconds
	onFailed:   function(checks) {
		checks.forEach(function(check) {
			console.log('The following check failed:', check.url, 'reason:', check.reason);
		});
	}
}));

app.get('/mongocheck', function(req, res){
	var db = mongojs('mongodb://localhost:27017/YOUR-MONGODB');
	db.runCommand({ping: 1}, function (err, resp) {
	    if(!err && resp.ok){
		 res.status(200).send({"status": "OK"})
	    }else{
		 res.status(500).send({"status": "NOT OK"})
	    }
	})
});

app.get('/escheck', function(req, res){
	var elasticsearch = require('elasticsearch');
 	var client = new elasticsearch.Client({
 		host: 'localhost:9200'
 	});
 	client.ping({
 		// ping usually has a 3000ms timeout
 		requestTimeout: Infinity,
 		// undocumented params are appended to the query string
 		hello: "elasticsearch!"
 		}, function (error) {
 		if (error) {
 		res.status(500).send({"status": "NOT OK"})
 		} else {
 		res.status(200).send({"status": "OK"})
 		}
 	});
});

app.get('/redischeck', function(req, res) {
  fooStatus.checkStatus(function(err) {
    res.send(err || 'great');
  });
});
