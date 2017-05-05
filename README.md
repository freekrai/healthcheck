# Healthchecks

This is a drop in healthcheck that runs health checks on your application.  Allows you to
manage a list of healthchecks as plain text files, keep them in source control
next to the application.  Provides a single endpoint you can access from a
mobile device, or from a monitoring service.

## What and Why?

A health check is a simple ping to a resource of your web application that
checks that your application is up and running, responding to network requests,
and behaving correctly.

It can be as simple as pinging the home page of a web site, checking that the
page includes the company's name in the title.

If you have a complex application, there are multiple things that can break
independently, and so you want a good health coverage by checking multiple
resources (see [What Should I Check?](#what-should-i-check)).

If your application has got one page that's accessing the database, and another
page that just storing requests in a queue, you want to check both.

Whether you're using a service like Uptime Robot or internal tool like Nagios, if
you store your checks there, funny thing is they never get updated when you roll
out new features.

You want checks to be part of the code base, in source control, right next to
the application code that's getting checked, where it can be versioned and code
reviewed.

And it gives you a single endpoint that you can open in a browser, to see a list
of all passed or failed checks.  The same endpoint you can also use with a
monitoring service like Uptime Robot or Nagios.

## What Should I Check?

> Anything that can go wrong will go wrong.
>
> -- Murphy's law

_Seriously, Murphy is the reason why plugins have one prong larger than the other, so he knows what he's talking about._

If two parts of your application can fail independently, you want to check both.

If you have static and dynamic page, you want to check both.

If different pages use different database servers, you want to check them all.

If some page uses a caching servers, you want to check that as well.

If another page uses a 3rd party API, also check that.

If your page is composed of multiple modules that can fail independently (say
shopping cart and product list), you want to check each module.

If something can fail that's not an HTML page, you want to check that as well.

Stylesheets? Check.  Client-side scripts?  Checks.  Images?  Checks.

If they are pre-processed, you want to check what was generated.

If it's served by a 3rd party CDN, don't skip this check.

If your application dynamically generates links (to pages, CSS, JS), check those
as well.

You can have too many checks, but most likely your problem is you don't have
enough!


----

## Internals

Ok, let's get into how it works.

### Setting up

For the most part, this app uses our usual pm2 set up. A docker image is planned as well.

The files in the `init` folder are used to handle having it run with pm2.

We also have to add an nginx rule:

```
location /health/ {
    proxy_pass         http://127.0.0.1:3012/healthcheck;
    proxy_redirect     off;
    proxy_set_header   Host             $host;
    proxy_set_header   X-Real-IP        $remote_addr;
    proxy_set_header   X-Forwarded-For  $proxy_add_x_forwarded_for;
    proxy_set_header   X-NginX-Proxy    true;
    proxy_connect_timeout      180;
    proxy_send_timeout         180;
    proxy_read_timeout         180;
    proxy_buffer_size          4k;
    proxy_buffers              4 32k;
    proxy_busy_buffers_size    64k;
    proxy_temp_file_write_size 64k;

    # websockets:
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    client_max_body_size       30m;
    client_body_buffer_size    128k;
}
```

So that `/health/` points to our healthcheck app.

If you want to use this in your apps, you can look at `index.js` and how the routes work, this is meant to run on its own but can be added to existing apps easily enough as well.

I personally recommend running the healthcheck as its own app so that if your website does go down, then it doesn't take the healthcheck down as well (though that in itself would trigger alarms).

### Adding checks

There is a file called `checks` that you can use to add your checks to:

```
# check mongo
http://127.0.0.1:3012/mongocheck

# check elasticsearch
http://127.0.0.1:3012/escheck

# check main site
https://example.com
https://admin.example.com
```

You can add as many URLs to check as you want, even static assets such as `https://example.com/images/logo.png`

This lets us perform checks on various URLs we may be using on our sites, we can even have checks run on other URLs that our site may depend on.

For mongo, elasticsearch, redis or any other check that involves establishing a connection, we set up a route inside index.js:

For mongo, we use:

```
app.get('/mongocheck', function(req, res){
	var db = mongojs('mongodb://localhost:27017/YOUR-MONGO-DB');
	db.runCommand({ping: 1}, function (err, resp) {
		if(!err && resp.ok){
			res.status(200).send({"status": "OK"})
		}else{
			res.status(500).send({"status": "NOT OK"})
		}
	})
});
```
And for elasticsearch we use:

```
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
```

And for redis:

```
var fooStatus = require('redis-status')({
  name: 'redis',
  port: 6379,
  host: 'localhost'
});

app.get('/redischeck', function(req, res) {
	fooStatus.checkStatus(function(err) {
		res.send(err || 'great');
	});
});
```

This can be adapted to any other apps such as redis, rethinkdb, etc, and I'll add routes for them as well.

We then add the URLs to our `checks` file as described above.


### Attribution

Forked from [Broadly/node-healthchecks](https://github.com/broadly/node-healthchecks) and additions made to it to clean it up and also add support for the other libraries, so that you can just drop it onto a server, set up PM2 and be ready to go, or integrate into existing apps.
