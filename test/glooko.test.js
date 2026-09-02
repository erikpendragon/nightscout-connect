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
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals|temporary_basals|extended_boluses|readings)|foods|readings|blood_pressures|cgm\/insulin_events|cgm\/carbs_events)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ], bloodPressures: [ ], readings: [ ], insulinEvents: [ ], carbsEvents: [ ],
                                       normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ], temporaryBasals: [ ], extendedBoluses: [ ] } });
    }
    if (call.path === '/api/v3/users/summary/histories') { assertHasNoV2SyncParams(call); return Promise.resolve({ data: { histories: [ ] } }); }
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
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals|temporary_basals|extended_boluses|readings)|foods|readings|blood_pressures|cgm\/insulin_events|cgm\/carbs_events)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ], bloodPressures: [ ], readings: [ ], insulinEvents: [ ], carbsEvents: [ ],
                                       normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ], temporaryBasals: [ ], extendedBoluses: [ ] } });
    }
    if (call.path === '/api/v3/users/summary/histories') { assertHasNoV2SyncParams(call); return Promise.resolve({ data: { histories: [ ] } }); }
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
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals|temporary_basals|extended_boluses|readings)|foods|readings|blood_pressures|cgm\/insulin_events|cgm\/carbs_events)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ], bloodPressures: [ ], readings: [ ], insulinEvents: [ ], carbsEvents: [ ],
                                       normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ], temporaryBasals: [ ], extendedBoluses: [ ] } });
    }
    if (call.path === '/api/v3/users/summary/histories') { assertHasNoV2SyncParams(call); return Promise.resolve({ data: { histories: [ ] } }); }
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
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals|temporary_basals|extended_boluses|readings)|foods|readings|blood_pressures|cgm\/insulin_events|cgm\/carbs_events)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ], bloodPressures: [ ], readings: [ ], insulinEvents: [ ], carbsEvents: [ ],
                                       normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ], temporaryBasals: [ ], extendedBoluses: [ ] } });
    }
    if (call.path === '/api/v3/users/summary/histories') { assertHasNoV2SyncParams(call); return Promise.resolve({ data: { histories: [ ] } }); }
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
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals|temporary_basals|extended_boluses|readings)|foods|readings|blood_pressures|cgm\/insulin_events|cgm\/carbs_events)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ], bloodPressures: [ ], readings: [ ], insulinEvents: [ ], carbsEvents: [ ], normalBoluses: [ ], scheduledBasals: [ ], temporaryBasals: [ ], extendedBoluses: [ ] } });
    }
    if (call.path === '/api/v3/users/summary/histories') { assertHasNoV2SyncParams(call); return Promise.resolve({ data: { histories: [ ] } }); }
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

test('Glooko transform maps temporary basals by absolute rate, or by percentage when no rate is given', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    temporaryBasals: [
      { pumpTimestamp: '2026-08-31T15:43:35.000Z', duration: 1800, rate: 0.21, percentage: '0.25', guid: 'tb-rate' },
      { pumpTimestamp: '2026-08-31T16:43:35.000Z', duration: 3600, rate: null, percentage: 0.25, guid: 'tb-fraction' },
      { pumpTimestamp: '2026-08-31T17:43:35.000Z', duration: 3600, percent: 150, tempBasalType: 'percent', guid: 'tb-percent' },
      { pumpTimestamp: '2026-08-31T18:43:35.000Z', ended: '2026-08-31T19:13:35.000Z', rate: 0, guid: 'tb-ended' },
      { pumpTimestamp: '2026-08-31T19:43:35.000Z', duration: 600, guid: 'tb-nothing' }
    ]
  });

  const temps = result.treatments.filter(function (t) { return t.eventType === 'Temp Basal'; });
  assert.deepEqual(temps.map(function (t) { return t.glookoGuid; }), [ 'tb-rate', 'tb-fraction', 'tb-percent', 'tb-ended' ]);
  assert.equal(temps[0].absolute, 0.21);
  assert.equal(temps[0].rate, 0.21);
  assert.equal(temps[0].percent, undefined);
  assert.equal(temps[0].duration, 30);
  assert.equal(temps[0].enteredBy, 'glooko-temp-basal');
  assert.equal(temps[1].absolute, undefined);
  assert.equal(temps[1].percent, -75);
  assert.equal(temps[2].percent, 50);
  assert.match(temps[2].reason, /percent/);
  assert.equal(temps[3].absolute, 0);
  assert.equal(temps[3].duration, 30);
});

test('Glooko transform maps an extended bolus to a Combo Bolus with split, duration and relative rate', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    extendedBoluses: [
      { pumpTimestamp: '2026-08-31T18:00:00.000Z', insulinDelivered: 6, initialDelivery: 2, extendedDelivery: 4,
        extendedBolusDuration: 7200, carbsInput: 60, guid: 'eb-1' },
      { pumpTimestamp: '2026-08-31T20:00:00.000Z', insulinDelivered: 0, initialDelivery: 0, extendedDelivery: 0,
        extendedBolusDuration: 3600, guid: 'eb-empty' }
    ]
  });

  const combos = result.treatments.filter(function (t) { return t.eventType === 'Combo Bolus'; });
  assert.equal(combos.length, 1);
  const c = combos[0];
  assert.equal(c.glookoGuid, 'eb-1');
  assert.equal(c.eventTime, '2026-08-31T18:00:00.000Z');
  assert.equal(c.enteredinsulin, 6);
  assert.equal(c.insulin, 2);
  assert.equal(c.splitNow, 33);
  assert.equal(c.splitExt, 67);
  assert.equal(c.duration, 120);
  assert.equal(c.relative, 2);
  assert.equal(c.carbs, 60);
  assert.equal(c.enteredBy, 'glooko-extended-bolus');
});

test('Glooko data fetch requests temporary basals and extended boluses over the wide window', async () => {
  const paths = [];
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios((call) => {
    paths.push(call.path);
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) { return Promise.resolve({ data: { scheduledBasals: [] } }); }
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) { return Promise.resolve({ data: { normalBoluses: [] } }); }
    if (call.path.startsWith('/api/v2/cgm/readings')) { return Promise.resolve({ data: { readings: [] } }); }
    if (call.path === '/api/v2/pumps/temporary_basals') {
      assert.equal(call.options.params.patient, 'patient-123');
      return Promise.resolve({ data: { temporaryBasals: [ { pumpTimestamp: '2026-08-31T15:43:35.000Z', duration: 1800, rate: 0.5, guid: 'tb-1' } ] } });
    }
    if (call.path === '/api/v2/pumps/extended_boluses') {
      assert.equal(call.options.params.patient, 'patient-123');
      return Promise.resolve({ data: { extendedBoluses: [ { pumpTimestamp: '2026-08-31T18:00:00.000Z', insulinDelivered: 6, initialDelivery: 2, extendedDelivery: 4, extendedBolusDuration: 7200, guid: 'eb-1', softDeleted: true } ] } });
    }
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals|temporary_basals|extended_boluses|readings)|foods|readings|blood_pressures|cgm\/insulin_events|cgm\/carbs_events)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ], bloodPressures: [ ], readings: [ ], insulinEvents: [ ], carbsEvents: [ ], normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ] } });
    }
    if (call.path === '/api/v3/users/summary/histories') { assertHasNoV2SyncParams(call); return Promise.resolve({ data: { histories: [ ] } }); }
    throw new Error('unexpected path ' + call.path);
  }));

  const batch = await source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { userLogin: { glookoCode: 'patient-123' } }
  }, {});

  assert.ok(paths.includes('/api/v2/pumps/temporary_basals'));
  assert.ok(paths.includes('/api/v2/pumps/extended_boluses'));
  assert.deepEqual(batch.temporaryBasals.map(function (t) { return t.guid; }), [ 'tb-1' ]);
  assert.deepEqual(batch.extendedBoluses, [ ]);
});

test('Glooko transform maps pump glucose readings to BG Check treatments in mg/dl', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    pumpReadings: [
      { pumpTimestamp: '2026-08-31T08:00:00.000Z', value: 12000, type: 'manual', guid: 'pr-x100' },
      { pumpTimestamp: '2026-08-31T09:00:00.000Z', value: 6.7, units: 'mmol/L', guid: 'pr-mmol' },
      { timestamp: '2026-08-31T10:00:00.000Z', glucoseValue: 95, units: 'mg/dL', guid: 'pr-plain' },
      { pumpTimestamp: '2026-08-31T11:00:00.000Z', value: 0, guid: 'pr-zero' }
    ]
  });

  const checks = result.treatments.filter(function (t) { return t.eventType === 'BG Check'; });
  assert.deepEqual(checks.map(function (t) { return [ t.glookoGuid, t.glucose ]; }),
                   [ [ 'pr-x100', 120 ], [ 'pr-mmol', 121 ], [ 'pr-plain', 95 ] ]);
  assert.equal(checks[0].units, 'mg/dl');
  assert.equal(checks[0].glucoseType, 'Finger');
  assert.equal(checks[0].notes, 'Pump reading (manual)');
  assert.equal(checks[0].enteredBy, 'glooko-pump-reading');
  assert.equal(checks[2].eventTime, '2026-08-31T10:00:00.000Z');
});

test('Glooko transform imports CGM-app insulin and carb events as Notes, preferring systemTime', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: -7200000,
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    cgmInsulinEvents: [
      { systemTime: '2026-08-31T12:00:00.000Z', displayTime: '2026-08-31T14:00:00.000Z', insulin: 3.5, guid: 'ci-1' },
      { display_time: '2026-08-31T15:00:00.000Z', insulin: 0, guid: 'ci-zero' }
    ],
    cgmCarbsEvents: [
      { event_time: '2026-08-31T16:00:00.000Z', carbs: '29.0', guid: 'cc-1' }
    ]
  });

  const notes = result.treatments.filter(function (t) { return t.eventType === 'Note'; });
  assert.deepEqual(notes.map(function (t) { return t.glookoGuid; }), [ 'ci-1', 'cc-1' ]);
  assert.equal(notes[0].eventTime, '2026-08-31T12:00:00.000Z');
  assert.equal(notes[0].notes, 'Insulin logged in CGM app: 3.5 U');
  assert.equal(notes[0].glookoCgmInsulin, 3.5);
  assert.equal(notes[0].enteredBy, 'glooko-cgm-insulin');
  assert.equal(notes[1].eventTime, '2026-08-31T14:00:00.000Z');
  assert.equal(notes[1].notes, 'Carbs logged in CGM app: 29 g');
  assert.equal(notes[1].glookoCgmCarbs, 29);
  assert.equal(notes[1].enteredBy, 'glooko-cgm-carbs');
  assert.equal(result.treatments.filter(function (t) { return t.insulin || t.carbs; }).length, 0);
});

test('Glooko data fetch requests pump readings and CGM insulin/carb events over the wide window', async () => {
  const paths = [];
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios((call) => {
    paths.push(call.path);
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) { return Promise.resolve({ data: { scheduledBasals: [] } }); }
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) { return Promise.resolve({ data: { normalBoluses: [] } }); }
    if (call.path.startsWith('/api/v2/cgm/readings')) { return Promise.resolve({ data: { readings: [] } }); }
    if (call.path === '/api/v2/pumps/readings') {
      assert.equal(call.options.params.patient, 'patient-123');
      return Promise.resolve({ data: { readings: [ { pumpTimestamp: '2026-08-31T08:00:00.000Z', value: 12000, guid: 'pr-1' } ] } });
    }
    if (call.path === '/api/v2/cgm/insulin_events') {
      return Promise.resolve({ data: { insulinEvents: [ { system_time: '2026-08-31T12:00:00.000Z', insulin: 2, guid: 'ci-1', soft_deleted: true } ] } });
    }
    if (call.path === '/api/v2/cgm/carbs_events') {
      return Promise.resolve({ data: { carbsEvents: [ { systemTime: '2026-08-31T13:00:00.000Z', carbs: 20, guid: 'cc-1' } ] } });
    }
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals|temporary_basals|extended_boluses)|foods|readings|blood_pressures)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ], bloodPressures: [ ], normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ], temporaryBasals: [ ], extendedBoluses: [ ] } });
    }
    if (call.path === '/api/v3/users/summary/histories') { assertHasNoV2SyncParams(call); return Promise.resolve({ data: { histories: [ ] } }); }
    throw new Error('unexpected path ' + call.path);
  }));

  const batch = await source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { userLogin: { glookoCode: 'patient-123' } }
  }, {});

  assert.ok(paths.includes('/api/v2/pumps/readings'));
  assert.ok(paths.includes('/api/v2/cgm/insulin_events'));
  assert.ok(paths.includes('/api/v2/cgm/carbs_events'));
  assert.deepEqual(batch.pumpReadings.map(function (r) { return r.guid; }), [ 'pr-1' ]);
  assert.deepEqual(batch.cgmInsulinEvents, [ ]);
  assert.deepEqual(batch.cgmCarbsEvents.map(function (e) { return e.guid; }), [ 'cc-1' ]);
});

test('Glooko transform maps meter readings to BG Check treatments with the meal tag', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    meterReadings: [
      { timestamp: '2026-08-31T07:00:00.000Z', value: 9800, mealTag: 'before', guid: 'mr-x100' },
      { timestamp: '2026-08-31T08:00:00.000Z', value: 5.5, meterUnits: 'mmol/L', mealTag: 'none', guid: 'mr-mmol' },
      { timestamp: '2026-08-31T09:00:00.000Z', value: 0, guid: 'mr-zero' }
    ]
  });

  const checks = result.treatments.filter(function (t) { return t.eventType === 'BG Check'; });
  assert.deepEqual(checks.map(function (t) { return [ t.glookoGuid, t.glucose, t.notes ]; }),
                   [ [ 'mr-x100', 98, 'Meter reading (before meal)' ], [ 'mr-mmol', 99, 'Meter reading' ] ]);
  assert.equal(checks[0].enteredBy, 'glooko-meter-reading');
  assert.equal(checks[0].glucoseType, 'Finger');
  assert.equal(checks[0].units, 'mg/dl');
});

test('Glooko transform imports blood pressures as Notes with structured values', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    bloodPressures: [
      { timestamp: '2026-08-31T07:30:00.000Z', systolic: 121, diastolic: 79, units: 'mmHg', pulse: 68, guid: 'bp-1' },
      { timestamp: '2026-08-31T08:30:00.000Z', systolic: 118, diastolic: 76, guid: 'bp-2' },
      { timestamp: '2026-08-31T09:30:00.000Z', systolic: 0, diastolic: 0, guid: 'bp-zero' }
    ]
  });

  const notes = result.treatments.filter(function (t) { return t.eventType === 'Note'; });
  assert.deepEqual(notes.map(function (t) { return t.notes; }),
                   [ 'Blood pressure 121/79 mmHg, pulse 68', 'Blood pressure 118/76 mmHg' ]);
  assert.deepEqual(notes[0].glookoBloodPressure, { systolic: 121, diastolic: 79, units: 'mmHg', pulse: 68 });
  assert.deepEqual(notes[1].glookoBloodPressure, { systolic: 118, diastolic: 76, units: 'mmHg' });
  assert.equal(notes[0].enteredBy, 'glooko-blood-pressure');
  assert.equal(notes[0].glookoGuid, 'bp-1');
});

test('Glooko data fetch requests meter readings and blood pressures over the wide window', async () => {
  const paths = [];
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios((call) => {
    paths.push(call.path);
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) { return Promise.resolve({ data: { scheduledBasals: [] } }); }
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) { return Promise.resolve({ data: { normalBoluses: [] } }); }
    if (call.path.startsWith('/api/v2/cgm/readings')) { return Promise.resolve({ data: { readings: [] } }); }
    if (call.path === '/api/v2/readings') {
      assert.equal(call.options.params.patient, 'patient-123');
      return Promise.resolve({ data: { readings: [
        { timestamp: '2026-08-31T07:00:00.000Z', value: 9800, guid: 'mr-1' },
        { timestamp: '2026-08-31T07:30:00.000Z', value: 9900, guid: 'mr-seen' }
      ] } });
    }
    if (call.path === '/api/v2/blood_pressures') {
      return Promise.resolve({ data: { bloodPressures: [ { timestamp: '2026-08-31T07:30:00.000Z', systolic: 121, diastolic: 79, guid: 'bp-1', softDeleted: true } ] } });
    }
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals|temporary_basals|extended_boluses|readings)|foods|cgm\/insulin_events|cgm\/carbs_events)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ], normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ], temporaryBasals: [ ], extendedBoluses: [ ], readings: [ ], insulinEvents: [ ], carbsEvents: [ ] } });
    }
    if (call.path === '/api/v3/users/summary/histories') { assertHasNoV2SyncParams(call); return Promise.resolve({ data: { histories: [ ] } }); }
    throw new Error('unexpected path ' + call.path);
  }));

  const batch = await source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { userLogin: { glookoCode: 'patient-123' } }
  }, { seenGuids: [ 'mr-seen' ] });

  assert.ok(paths.includes('/api/v2/readings'));
  assert.ok(paths.includes('/api/v2/blood_pressures'));
  assert.deepEqual(batch.meterReadings.map(function (r) { return r.guid; }), [ 'mr-1' ]);
  assert.deepEqual(batch.bloodPressures, [ ]);
});

test('Glooko data fetch requests v3 histories with dates only and keeps unseen daily activity', async () => {
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
    if (call.path === '/api/v3/users/summary/histories') {
      assertHasNoV2SyncParams(call);
      assert.equal(call.options.params.patient, 'patient-123');
      assert.equal(typeof call.options.params.startDate, 'string');
      assert.equal(typeof call.options.params.endDate, 'string');
      return Promise.resolve({ data: { histories: [
        { type: 'validic_routines', guid: 'day-new', softDeleted: false, item: { timestamp: '2026-08-31T23:59:59.999Z', utcOffset: '-04:00', source: 'applehealth', steps: 8412.3, duration: 0, guid: 'item-new' } },
        { type: 'validic_routines', guid: 'day-seen', softDeleted: false, item: { timestamp: '2026-08-30T23:59:59.999Z', steps: 5000, guid: 'item-seen' } },
        { type: 'validic_routines', guid: 'day-gone', softDeleted: true, item: { timestamp: '2026-08-29T23:59:59.999Z', steps: 5000, guid: 'item-gone' } },
        { type: 'pumps_normal_boluses', guid: 'bolus-copy', item: { pumpTimestamp: '2026-08-31T12:00:00.000Z', insulinDelivered: 1 } }
      ] } });
    }
    if (/^\/api\/v2\/(pumps\/(events|alarms|scheduled_basals|normal_boluses|suspend_basals|temporary_basals|extended_boluses|readings)|foods|readings|blood_pressures|cgm\/insulin_events|cgm\/carbs_events)$/.test(call.path)) {
      return Promise.resolve({ data: { events: [ ], alarms: [ ], foods: [ ], bloodPressures: [ ], readings: [ ], insulinEvents: [ ], carbsEvents: [ ], normalBoluses: [ ], scheduledBasals: [ ], suspendBasals: [ ], temporaryBasals: [ ], extendedBoluses: [ ] } });
    }
    throw new Error('unexpected path ' + call.path);
  }));

  const batch = await source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { userLogin: { glookoCode: 'patient-123' } }
  }, { seenGuids: [ 'day-seen' ] });

  assert.equal(calls.filter(function (c) { return c.path === '/api/v3/users/summary/histories'; }).length, 1);
  assert.deepEqual(batch.activityDays.map(function (a) { return [ a.guid, a.steps ]; }), [ [ 'day-new', 8412.3 ] ]);
});

test('Glooko transform maps a daily step record to an Exercise treatment at the local end of day', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 4 * 60 * 60 * 1000,
    baseURL: 'https://ca.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    activityDays: [
      { timestamp: '2026-08-31T23:59:59.999Z', utcOffset: '-04:00', source: 'applehealth', steps: 8412.3, duration: 0,
        distance: null, calories: null, floors: null, elevation: null, guid: 'day-1' },
      { timestamp: '2026-08-30T23:59:59.999Z', source: 'applehealth', steps: 0, guid: 'day-zero' },
      { timestamp: '2026-08-29T23:59:59.999Z', source: 'garmin', steps: 12000, duration: 3600, distance: 9.1, calories: 480, guid: 'day-2' }
    ]
  });

  const ex = result.treatments.filter(function (t) { return t.eventType === 'Exercise'; });
  assert.deepEqual(ex.map(function (t) { return t.glookoGuid; }), [ 'day-1', 'day-2' ]);
  assert.equal(ex[0].eventTime, '2026-09-01T03:59:59.999Z');
  assert.equal(ex[0].notes, 'Daily steps: 8412 (applehealth)');
  assert.equal(ex[0].duration, undefined);
  assert.deepEqual(ex[0].glookoActivity, { steps: 8412, day: '2026-08-31', source: 'applehealth' });
  assert.equal(ex[0].enteredBy, 'glooko-activity');
  assert.equal(ex[1].duration, 60);
  assert.deepEqual(ex[1].glookoActivity, { steps: 12000, day: '2026-08-29', distance: 9.1, calories: 480, source: 'garmin' });
});
