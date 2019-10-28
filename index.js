"use strict";
var t0 = Date.now();

var express = require("express"),
    bl = require("bl"),
    labelModel = require('./lib/label-model'),
    metadata = require('./lib/metadata'),
    comment = require('./lib/comment'),
    checkRequest = require('./lib/check-request'),
    epochs = require('./lib/epochs'),
    filter = require('./lib/filter'),
    q = require('q');

function waitFor(ms) {
    var deferred = q.defer();
    setTimeout(function() { deferred.resolve(); }, ms);
    return deferred.promise;
}

var app = module.exports = express();

function logArgs() {
    var args = arguments;
    process.nextTick(function() {
        console.log.apply(console, args);
    });
}

function funkLogMsg(num, msg) {
    return function() { logArgs("#" + num + ": " + msg); };
}

function funkLogErr(num, msg) {
    return function(err) { logArgs("#" + num + ": " + msg + "\n", err); };
}

var currentlyRunning = {};

app.post('/github-hook', function (req, res) {
    req.pipe(bl(function (err, body) {
        if (err) {
            logArgs(err.message);
        } else if (process.env.NODE_ENV != 'production' || checkRequest(body, req.headers["x-hub-signature"], process.env.GITHUB_SECRET)) {
            res.send(new Date().toISOString());

            try {
                body = JSON.parse(body);
            } catch(e) {
                return;
            }
            if (!filter.event(body, logArgs)) {
                return;
            }
            if (!filter.pullRequest(body.pull_request, logArgs)) {
                return;
            }

            var action = body.action;
            var pr = body.pull_request;
            var n = pr.number;
            var u = (pr.user && pr.user.login) || null;
            var content = pr.body || "";
            if (action == "opened" || action == "synchronize" ||
                action == "ready_for_review") {
                if (n in currentlyRunning) {
                    logArgs("#" + n + " is already being processed.");
                    return;
                }
                currentlyRunning[n] = true;
                logArgs("#" + n, action);

                waitFor(5 * 1000).then(function() { // Avoid race condition
                    return metadata(n, u, content).then(function(metadata) {
                        logArgs(metadata);
                        return labelModel.post(n, metadata.labels).then(
                            funkLogMsg(n, "Added missing LABELS if any."),
                            funkLogErr(n, "Something went wrong while adding missing LABELS.")
                        ).then(function() {
                            return comment(n, metadata);
                        }).then(
                            funkLogMsg(n, "Added missing REVIEWERS if any."),
                            funkLogErr(n, "Something went wrong while adding missing REVIEWERS.")
                        );
                    });
                }).then(function() {
                    delete currentlyRunning[n];
                }, function(err) {
                    delete currentlyRunning[n];
                    funkLogErr(n, "THIS SHOULDN'T EVER HAPPEN")(err);
                });
            } else {
                logArgs("#" + n + ": not handled.", "action:", action);
            }
        } else {
            logArgs("Unverified request", req);
        }
    }));
});

var knownEpochs = [ 'weekly', 'daily', 'twelve_hourly', 'six_hourly' ];
var inFlightEpochs = {};
var updateEpoch = function (epoch) {
    if (inFlightEpochs[epoch]) {
        logArgs("Skipping epoch update: previous update still in progress",
            epoch);
        return;
    }
    inFlightEpochs[epoch] = true;

    logArgs("Updating epoch", epoch);

    // Timeout update operation after 1.5 minutes.
    var timeout = q.defer();
    setTimeout(timeout.reject.bind(timeout,
            new Error(`Epoch update for ${epoch} timed out`)),
        90 * 1000);
    q.race([
        // Defer to epochs library for update.
        epochs.updateEpoch(epoch), timeout.promise
    ]).then(function (next) {
        delete inFlightEpochs[epoch];
        logArgs("Updated epoch", epoch, next);
    }, function (err) {
        delete inFlightEpochs[epoch];
        logArgs("Error updating epoch", epoch, "\n", err);
    });
};

for (var i = 0; i < knownEpochs.length; i++) {
    setInterval(updateEpoch.bind(global, knownEpochs[i]), 2 * 60 * 1000);
}

var port = process.env.PORT || 5000;
app.listen(port, function() {
    console.log("Express server listening on port %d in %s mode", port, app.settings.env);
    console.log("App started in", (Date.now() - t0) + "ms.");
});
