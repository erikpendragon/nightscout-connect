
var qs = require('querystring');
var url = require('url');
var crypto = require('crypto');

function encode_api_secret(plain) {
  var shasum = crypto.createHash('sha1');
  shasum.update(plain);
  return shasum.digest('hex').toLowerCase( );
}

function nightscoutRestAPI (config, axios) {
  if (!config || !config.url) {
    throw new Error('Nightscout output requires CONNECT_NIGHTSCOUT_ENDPOINT or --nightscoutEndpoint.');
  }
  if (!config.apiSecret) {
    throw new Error('Nightscout output requires CONNECT_API_SECRET or --apiSecret.');
  }
  // TODO change this, exposes secret in logs
  console.log("SETTING UP nightscoutRestAPI", config);
  var endpoint = url.parse(config.url);
  var baseURL = url.format({
    protocol: endpoint.protocol
  , host: endpoint.host
  , pathname: endpoint.pathname
  });
  var params = qs.parse(endpoint.query);
  var apiSecret = config.apiSecret;
  var apiHash = encode_api_secret(apiSecret);
  var http = axios.create({ baseURL });

  // function gap_for (kind, dt) { }
  // function record_kind (kind, data, dt) { }
  var bookmark = null;

  function record_glucose (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/entries.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH, total entries", resp.data.length);
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR", err);
    });
  }

  function record_treatments (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/treatments.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH, total treatments", resp.data.length);
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR", err);
    });
  }
  function record_devicestatus (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/devicestatus.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH, total devicestatus", resp.data.length);
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR", err);
    });
  }

  function record_profiles (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/profile.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH, total profiles", resp.data.length);
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR", err);
    });
  }

  function newestDate (data, field) {
    if (!data || !data.length) {
      return null;
    }
    return data
      .map((item) => item && item[field] ? new Date(item[field]) : null)
      .filter(Boolean)
      .sort((a, b) => b.getTime( ) - a.getTime( ))
      .shift( );
  }

  function bookmark_collection (collection, field, data) {
    var newest = newestDate(data, field);
    if (newest) {
      bookmark[collection] = newest;
    }
    return Promise.resolve(data);
  }

  function record_batch (batch) {
    batch = batch || { };
    bookmark = bookmark || { };
    var { entries, treatments, profiles, devicestatus } = batch;
    entries = entries || [ ];
    treatments = treatments || [ ];
    profiles = profiles || [ ];
    devicestatus = devicestatus || [ ];
    console.log("RECORD BATCH with", entries.length, 'entries,', treatments.length, 'treatments,', devicestatus.length, 'devicestatus,', profiles.length, 'profiles');
    /*
    if (!batch.entries.length) {
      return Promise.resolve(bookmark);
    }
    */
    return Promise.all([
        record_glucose(entries).then(bookmark_collection.bind(null, 'entries', 'dateString')),
        record_treatments(treatments).then(bookmark_collection.bind(null, 'treatments', 'created_at')),
        record_devicestatus(devicestatus).then(bookmark_collection.bind(null, 'devicestatus', 'created_at')),
        record_profiles(profiles).then(bookmark_collection.bind(null, 'profiles', 'created_at'))
      ]).then(function update_bookmark (settled) {
        console.log("UPDATE BOOKMARK FROM I/O", bookmark, settled[0], settled.length);
        return bookmark;
    });
    // return Promise.resolve(batch);

  }
  record_batch.gap_for = function ( ) {
    console.log("FETCHING GAPS INFORMATION");
    if (bookmark) {
      return Promise.resolve(bookmark);
    }
    bookmark = { };
    var headers = { 'API-SECRET': apiHash };
    var query = { count: 1 };
    return Promise.all([
      http.get('/api/v1/entries.json', { params: query, headers }).then((resp) => {
        bookmark.entries = newestDate(resp.data, 'dateString') || bookmark.entries;
      }),
      http.get('/api/v1/treatments.json', { params: query, headers }).then((resp) => {
        bookmark.treatments = newestDate(resp.data, 'created_at') || bookmark.treatments;
      }),
      http.get('/api/v1/devicestatus.json', { params: query, headers }).then((resp) => {
        bookmark.devicestatus = newestDate(resp.data, 'created_at') || bookmark.devicestatus;
      }),
      http.get('/api/v1/profile.json', { params: query, headers }).then((resp) => {
        bookmark.profiles = newestDate(resp.data, 'created_at') || bookmark.profiles;
      }),
    ]).then(( ) => {
      console.log("UPDATED BOOKMARKS", bookmark);
    }).catch((err) => {
      var status = err && err.response && err.response.status;
      var data = err && err.response && err.response.data;
      console.log("FAILED TO DETERMINE GAP", err && err.request, status, data);
    })
    .then(( ) => {
      console.log("FINAL GAP", bookmark);
      return bookmark;
    });;

  }
  return record_batch;

}
module.exports = nightscoutRestAPI;
