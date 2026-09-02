const assert = require('node:assert/strict');
const test = require('node:test');

const glookoSource = require('../lib/sources/glooko');

function fakeAxios (handler) {
  return {
    create (defaults) {
      return {
        get (path, options) {
          return handler({ method: 'get', path, options, defaults });
        },
        post (path, body, options) {
          return handler({ method: 'post', path, body, options, defaults });
        }
      };
    }
  };
}

function assertHasV2SyncParams (call) {
  assert.ok(call.options.params);
  assert.ok(call.options.params.lastGuid);
  assert.equal(typeof call.options.params.lastUpdatedAt, 'string');
  assert.ok(call.options.params.limit > 0);
}

function assertHasNoV2SyncParams (call) {
  const params = call.options && call.options.params || {};

  assert.equal(params.lastGuid, undefined);
  assert.equal(params.lastUpdatedAt, undefined);
  assert.equal(params.limit, undefined);
}

test('Glooko validation supports default, EU, and explicit servers', () => {
  const common = {
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret'
  };

  assert.equal(glookoSource.validate(common).config.baseURL, 'https://api.glooko.com');
  assert.equal(glookoSource.validate({ ...common, glookoEnv: 'eu' }).config.baseURL, 'https://eu.api.glooko.com');
  assert.equal(glookoSource.validate({ ...common, glookoEnv: 'ca' }).config.baseURL, 'https://ca.api.glooko.com');
  assert.equal(
    glookoSource.validate({ ...common, glookoServer: 'de-fr.api.glooko.com' }).config.baseURL,
    'https://de-fr.api.glooko.com'
  );
  assert.equal(
    glookoSource.validate({ ...common, glookoServer: 'de-fr.api.glooko.com' }).config.glookoWebOrigin,
    'https://de-fr.my.glooko.com'
  );
});

test('Glooko validation carries stable device identity, auth mode, graph flag, and timezone offset', () => {
  const result = glookoSource.validate({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 2,
    glookoDeviceId: 'device-123',
    glookoSerialNumber: 'serial-123',
    glookoUseV3Graph: 'true',
    glookoAuthMode: 'auto'
  });

  assert.equal(result.ok, true);
  assert.equal(result.config.glookoTimezoneOffset, -7200000);
  assert.equal(result.config.glookoDeviceId, 'device-123');
  assert.equal(result.config.glookoSerialNumber, 'serial-123');
  assert.equal(result.config.glookoUseV3Graph, true);
  assert.equal(result.config.glookoAuthMode, 'auto');
});

test('Glooko validation keeps unknown auth modes on safe api default', () => {
  const result = glookoSource.validate({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'surprise'
  });

  assert.equal(result.config.glookoAuthMode, 'api');
});

test('Glooko auth sends configurable Android device identity', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoDeviceId: 'device-123',
    glookoSerialNumber: 'serial-123',
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    assert.equal(call.path, '/api/v2/users/sign_in');
    assert.equal(call.body.deviceInformation.deviceId, 'device-123');
    assert.equal(call.body.deviceInformation.serialNumber, 'serial-123');
    assert.equal(call.body.deviceInformation.applicationType, 'logbook');
    assert.equal(call.defaults.headers.Origin, 'https://eu.my.glooko.com');
    return Promise.resolve({
      headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
      data: { userLogin: { glookoCode: 'patient-123' } }
    });
  }));

  assert.deepEqual(await source.authFromCredentials(), {
    cookies: '_logbook-web_session=session-123; path=/',
    user: { userLogin: { glookoCode: 'patient-123' } }
  });
});

test('Glooko API auth fails clearly when two-factor is required', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    baseURL: 'https://api.glooko.com'
  }, fakeAxios(() => Promise.resolve({
    headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
    data: { twoFaRequired: true }
  })));

  await assert.rejects(() => source.authFromCredentials(), /two-factor/);
});

test('Glooko auth supports explicit regional web origin overrides', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoDeviceId: 'device-123',
    glookoSerialNumber: 'serial-123',
    glookoWebOrigin: 'https://custom.my.glooko.example',
    baseURL: 'https://de-fr.api.glooko.com'
  }, fakeAxios((call) => {
    assert.equal(call.defaults.headers.Origin, 'https://custom.my.glooko.example');
    assert.equal(call.defaults.headers.Referer, 'https://custom.my.glooko.example/');
    return Promise.resolve({
      headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
      data: { userLogin: { glookoCode: 'patient-123' } }
    });
  }));

  await source.authFromCredentials();
});

test('Glooko web auth mode uses CSRF form login and returns session cookie', async () => {
  const calls = [];
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'web',
    baseURL: 'https://eu.api.glooko.com',
    glookoWebOrigin: 'https://eu.my.glooko.com'
  }, fakeAxios((call) => {
    calls.push(call);
    if (call.method === 'get' && call.path === '/users/sign_in?locale=en-GB') {
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=preauth; path=/'] },
        data: '<input type="hidden" name="authenticity_token" value="csrf-123">'
      });
    }
    if (call.method === 'post' && call.path === '/users/sign_in?id=login_form') {
      assert.match(call.body, /authenticity_token=csrf-123/);
      assert.match(call.body, /user%5Bemail%5D=user%40example.com/);
      assert.match(call.body, /language=en/);
      assert.match(call.body, /redirect_to=%2F/);
      assert.equal(call.options.headers.Cookie, '_logbook-web_session=preauth; path=/');
      assert.equal(call.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
        data: { success: true }
      });
    }
    throw new Error('unexpected call ' + call.method + ' ' + call.path);
  }));

  assert.deepEqual(await source.authFromCredentials(), {
    cookies: '_logbook-web_session=session-123; path=/',
    user: { success: true }
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'get /users/sign_in?locale=en-GB',
    'post /users/sign_in?id=login_form'
  ]);
});

test('Glooko web auth can extract CSRF token from meta tag', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'web',
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    if (call.method === 'get') {
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=preauth; path=/'] },
        data: '<meta name="csrf-token" content="csrf-meta-123">'
      });
    }
    assert.match(call.body, /authenticity_token=csrf-meta-123/);
    return Promise.resolve({
      headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
      data: { success: true }
    });
  }));

  assert.equal((await source.authFromCredentials()).cookies, '_logbook-web_session=session-123; path=/');
});

test('Glooko web auth fails clearly when two-factor is required', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'web',
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    if (call.method === 'get') {
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=preauth; path=/'] },
        data: '<input type="hidden" name="authenticity_token" value="csrf-123">'
      });
    }
    return Promise.resolve({
      headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
      data: { two_fa_required: true }
    });
  }));

  await assert.rejects(() => source.authFromCredentials(), /two-factor/);
});

test('Glooko web auth fails clearly when CSRF token is missing', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'web',
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    if (call.method === 'get') {
      return Promise.resolve({ headers: {}, data: '<html>No token</html>' });
    }
    throw new Error('unexpected call');
  }));

  await assert.rejects(() => source.authFromCredentials(), /authenticity_token/);
});

test('Glooko auto auth mode falls back to web login on 422', async () => {
  const calls = [];
  const err = new Error('InvalidAuthenticityToken');
  err.response = { status: 422, data: 'The change you wanted was rejected' };
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'auto',
    baseURL: 'https://eu.api.glooko.com',
    glookoWebOrigin: 'https://eu.my.glooko.com'
  }, fakeAxios((call) => {
    calls.push(call);
    if (call.method === 'post' && call.path === '/api/v2/users/sign_in') {
      return Promise.reject(err);
    }
    if (call.method === 'get' && call.path === '/users/sign_in?locale=en-GB') {
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=preauth; path=/'] },
        data: '<input type="hidden" value="csrf-123" name="authenticity_token">'
      });
    }
    if (call.method === 'post' && call.path === '/users/sign_in?id=login_form') {
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
        data: { success: true }
      });
    }
    throw new Error('unexpected call ' + call.method + ' ' + call.path);
  }));

  assert.equal((await source.authFromCredentials()).cookies, '_logbook-web_session=session-123; path=/');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'post /api/v2/users/sign_in',
    'get /users/sign_in?locale=en-GB',
    'post /users/sign_in?id=login_form'
  ]);
});

test('Glooko transform maps v2 CGM readings to Nightscout entries', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    baseURL: 'https://api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [
      { timestamp: '2025-10-09T08:53:20.000Z', value: 12345, guid: 'reading-1' },
      { timestamp: '2025-10-09T08:58:20.000Z', value: 0, guid: 'zero' },
      { timestamp: '2025-10-09T09:03:20.000Z', value: 13000, softDeleted: true }
    ]
  });

  assert.deepEqual(result.entries, [{
    type: 'sgv',
    device: 'nightscout-connect-glooko',
    date: 1760000000000,
    dateString: '2025-10-09T08:53:20.000Z',
    sgv: 123,
    direction: 'Flat'
  }]);
});

test('Glooko transform maps v3 graph CGM fallback readings', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    glookoUseV3Graph: true,
    baseURL: 'https://api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    v3Graph: {
      series: {
        cgmHigh: [{ x: 1760000300, timestamp: '2025-10-09T08:58:20.000Z', value: 18000 }],
        cgmNormal: [{ x: 1760000000, timestamp: '2025-10-09T08:53:20.000Z', value: 12345 }],
        cgmLow: [{ x: 1760000600, timestamp: '2025-10-09T09:03:20.000Z', y: 65, calculated: true }]
      }
    }
  });

  assert.deepEqual(result.entries.map((entry) => ({
    sgv: entry.sgv,
    dateString: entry.dateString,
    device: entry.device
  })), [
    { sgv: 123, dateString: '2025-10-09T08:53:20.000Z', device: 'nightscout-connect-glooko-v3' },
    { sgv: 180, dateString: '2025-10-09T08:58:20.000Z', device: 'nightscout-connect-glooko-v3' }
  ]);
});

test('Glooko v3 graph fallback converts mmol/L display values when value is absent', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    glookoUseV3Graph: true,
    baseURL: 'https://api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    userProfile: { currentUser: { meterUnits: 'mmoll' } },
    v3Graph: {
      series: {
        cgmNormal: [{ x: 1760000000, timestamp: '2025-10-09T08:53:20.000Z', y: 6.7 }]
      }
    }
  });

  assert.equal(result.entries[0].sgv, 121);
});

test('Glooko data fetch adds v3 graph fallback when v2 CGM readings are empty', async () => {
  const calls = [];
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoUseV3Graph: true,
    baseURL: 'https://de-fr.api.glooko.com',
    glookoWebOrigin: 'https://de-fr.my.glooko.com'
  }, fakeAxios((call) => {
    calls.push(call);
    assert.equal(call.options.headers.Host, 'de-fr.api.glooko.com');
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) {
      assertHasV2SyncParams(call);
      return Promise.resolve({ data: { scheduledBasals: [] } });
    }
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) {
      assertHasV2SyncParams(call);
      return Promise.resolve({ data: { normalBoluses: [] } });
    }
    if (call.path.startsWith('/api/v2/cgm/readings')) {
      assertHasV2SyncParams(call);
      return Promise.resolve({ data: { readings: [] } });
    }
    if (call.path.startsWith('/api/v3/graph/data')) {
      assertHasNoV2SyncParams(call);
      assert.match(call.path, /series\[\]=cgmNormal/);
      assert.doesNotMatch(call.path, /series%5B%5D/);
      return Promise.resolve({ data: { series: { cgmNormal: [{ x: 1760000000, value: 12345 }] } } });
    }
    // The pump-event, alarm and food collections are fetched over their own
    // wide window with a bare path. Answer them emptily so tests that are not
    // about them do not have to care.
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals)|foods)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ],
                                       normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ] } });
    }
    throw new Error('unexpected path ' + call.path);
  }));

  const batch = await source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { userLogin: { glookoCode: 'patient-123' } }
  }, { entries: new Date('2025-10-09T08:48:20.000Z') });

  assert.deepEqual(batch.v3Graph, { series: { cgmNormal: [{ x: 1760000000, value: 12345 }] } });
  assert.equal(calls.filter(function (c) { return c.path.includes('?'); }).length, 4);
});

test('Glooko data fetch can resolve patient code from v3 session profile before graph fallback', async () => {
  const calls = [];
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoUseV3Graph: true,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    calls.push(call);
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) {
      assertHasV2SyncParams(call);
      return Promise.resolve({ data: { scheduledBasals: [] } });
    }
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) {
      assertHasV2SyncParams(call);
      return Promise.resolve({ data: { normalBoluses: [] } });
    }
    if (call.path.startsWith('/api/v2/cgm/readings')) {
      assertHasV2SyncParams(call);
      return Promise.resolve({ data: { readings: [] } });
    }
    if (call.path === '/api/v3/session/users') {
      assertHasNoV2SyncParams(call);
      return Promise.resolve({ data: { currentUser: { glookoCode: 'patient-from-profile' } } });
    }
    if (call.path.startsWith('/api/v3/graph/data')) {
      assertHasNoV2SyncParams(call);
      assert.match(call.path, /patient=patient-from-profile/);
      return Promise.resolve({ data: { series: { cgmNormal: [{ x: 1760000000, value: 12345 }] } } });
    }
    // The pump-event, alarm and food collections are fetched over their own
    // wide window with a bare path. Answer them emptily so tests that are not
    // about them do not have to care.
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals)|foods)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ],
                                       normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ] } });
    }
    throw new Error('unexpected path ' + call.path);
  }));

  const batch = await source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { success: true }
  }, null);

  assert.deepEqual(batch.userProfile, { currentUser: { glookoCode: 'patient-from-profile' } });
  assert.deepEqual(batch.v3Graph, { series: { cgmNormal: [{ x: 1760000000, value: 12345 }] } });
});

test('Glooko transform applies configured timezone offset to fake-UTC readings', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: -7200000,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [{ timestamp: '2025-10-09T08:53:20.000Z', value: 11000 }]
  });

  assert.equal(result.entries[0].dateString, '2025-10-09T06:53:20.000Z');
});

test('Glooko transform tolerates missing readings', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    baseURL: 'https://api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  assert.deepEqual(source.transformData({}), { entries: [], treatments: [] });
});

test('Glooko incremental fetch uses the treatment bookmark when glucose is newer', async () => {
  const calls = [];
  const treatmentBookmark = new Date(Date.now() - (3 * 60 * 60 * 1000));
  const entryBookmark = new Date(Date.now() - (5 * 60 * 1000));
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'test-password',
    baseURL: 'https://api.glooko.com'
  }, fakeAxios((call) => {
    calls.push(call);
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) {
      return Promise.resolve({ data: { scheduledBasals: [] } });
    }
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) {
      return Promise.resolve({ data: { normalBoluses: [] } });
    }
    if (call.path.startsWith('/api/v2/cgm/readings')) {
      return Promise.resolve({ data: { readings: [] } });
    }
    // The pump-event, alarm and food collections are fetched over their own
    // wide window with a bare path. Answer them emptily so tests that are not
    // about them do not have to care.
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals)|foods)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ],
                                       normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ] } });
    }
    throw new Error('unexpected path ' + call.path);
  }));

  await source.dataFromSesssion({
    cookies: '_logbook-web_session=test-session',
    user: { userLogin: { glookoCode: 'test-patient' } }
  }, {
    entries: entryBookmark,
    treatments: treatmentBookmark
  });

  // The wide pump-event and food fetches use bare paths and a fixed window of
  // their own; this test is about the per-collection cursors, so look only at
  // the calls that carry one.
  const cursorCalls = calls.filter(function (c) { return c.path.includes('?'); });
  assert.equal(cursorCalls.length, 3);
  for (const call of cursorCalls) {
    const isTreatmentRequest = call.path.startsWith('/api/v2/pumps/');
    const expectedBookmark = isTreatmentRequest ? treatmentBookmark : entryBookmark;
    assert.equal(call.options.params.lastUpdatedAt, expectedBookmark.toISOString());
    if (isTreatmentRequest) {
      assert.ok(call.options.params.limit >= 35, `expected a treatment-sized window, got ${call.options.params.limit}`);
    } else {
      assert.ok(call.options.params.limit <= 2, `expected an entry-sized window, got ${call.options.params.limit}`);
    }
  }
});

test('Glooko authentication and fetch logs omit session and patient identifiers', async () => {
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.map((arg) => {
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch (_) { return String(arg); }
  }).join(' '));

  try {
    const source = glookoSource({
      glookoEmail: 'user@example.com',
      glookoPassword: 'test-password',
      baseURL: 'https://api.glooko.com'
    }, fakeAxios((call) => {
      if (call.method === 'post') {
        return Promise.resolve({
          headers: { 'set-cookie': ['_logbook-web_session=private-cookie; path=/'] },
          data: { userLogin: { glookoCode: 'private-patient-code' } }
        });
      }
      if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) {
        return Promise.resolve({ data: { scheduledBasals: [] } });
      }
      if (call.path.startsWith('/api/v2/pumps/normal_boluses')) {
        return Promise.resolve({ data: { normalBoluses: [] } });
      }
      if (call.path.startsWith('/api/v2/cgm/readings')) {
        return Promise.resolve({ data: { readings: [] } });
      }
      // The pump-event, alarm and food collections are fetched over their own
    // wide window with a bare path. Answer them emptily so tests that are not
    // about them do not have to care.
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals)|foods)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ],
                                       normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ] } });
    }
    throw new Error('unexpected path ' + call.path);
    }));

    const session = await source.authFromCredentials();
    await source.dataFromSesssion(session, null);
  } finally {
    console.log = originalLog;
  }

  const output = logged.join('\n');
  assert.doesNotMatch(output, /private-cookie/);
  assert.doesNotMatch(output, /private-patient-code/);
});

test('Glooko data fetch requests pump suspensions over the wide window and drops seen or deleted ones', async () => {
  const calls = [];
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios((call) => {
    calls.push(call);
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) { return Promise.resolve({ data: { scheduledBasals: [] } }); }
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) { return Promise.resolve({ data: { normalBoluses: [] } }); }
    if (call.path.startsWith('/api/v2/cgm/readings')) { return Promise.resolve({ data: { readings: [] } }); }
    if (call.path === '/api/v2/pumps/suspend_basals') {
      assert.equal(call.options.params.patient, 'patient-123');
      assert.equal(typeof call.options.params.startDate, 'string');
      assert.equal(typeof call.options.params.lastUpdatedAt, 'string');
      return Promise.resolve({ data: { suspendBasals: [
        { pumpTimestamp: '2026-08-31T14:27:02.000Z', duration: 3405, type: 'manual', guid: 'susp-new', softDeleted: false },
        { pumpTimestamp: '2026-08-30T10:00:00.000Z', duration: 120, type: 'manual', guid: 'susp-seen', softDeleted: false },
        { pumpTimestamp: '2026-08-29T10:00:00.000Z', duration: 60, type: 'manual', guid: 'susp-gone', softDeleted: true }
      ] } });
    }
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses)|foods)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ], normalBoluses: [ ], scheduledBasals: [ ] } });
    }
    throw new Error('unexpected path ' + call.path);
  }));

  const batch = await source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { userLogin: { glookoCode: 'patient-123' } }
  }, { seenGuids: [ 'susp-seen' ] });

  assert.deepEqual(batch.suspendBasals.map(function (s) { return s.guid; }), [ 'susp-new' ]);
});

test('Glooko transform maps a pump suspension to a zero-rate Temp Basal', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    suspendBasals: [
      { pumpTimestamp: '2026-08-31T14:27:02.000Z', pumpTimestampUtcOffset: '+00:00', duration: 3405,
        type: 'manual', rateAtStart: null, rateAtResume: 0.55, guid: 'susp-1', softDeleted: false }
    ]
  });

  const temps = result.treatments.filter(function (t) { return t.eventType === 'Temp Basal'; });
  assert.equal(temps.length, 1);
  assert.equal(temps[0].rate, 0);
  assert.equal(temps[0].absolute, 0);
  assert.equal(temps[0].duration, 56.8);
  assert.equal(temps[0].eventTime, '2026-08-31T14:27:02.000Z');
  assert.equal(temps[0].created_at, '2026-08-31T14:27:02.000Z');
  assert.equal(temps[0].glookoGuid, 'susp-1');
  assert.equal(temps[0].glookoRateAtResume, 0.55);
  assert.equal(temps[0].glookoRateAtStart, undefined);
  assert.match(temps[0].reason, /manual/);
  assert.equal(temps[0].enteredBy, 'glooko-suspend');
});
