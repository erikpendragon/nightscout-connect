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

test('Glooko validation supports default, EU, and explicit servers', () => {
  const common = {
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret'
  };

  assert.equal(glookoSource.validate(common).config.baseURL, 'https://api.glooko.com');
  assert.equal(glookoSource.validate({ ...common, glookoEnv: 'eu' }).config.baseURL, 'https://eu.api.glooko.com');
  assert.equal(
    glookoSource.validate({ ...common, glookoServer: 'de-fr.api.glooko.com' }).config.baseURL,
    'https://de-fr.api.glooko.com'
  );
});

test('Glooko validation carries stable device identity and timezone offset', () => {
  const result = glookoSource.validate({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 2,
    glookoDeviceId: 'device-123',
    glookoSerialNumber: 'serial-123'
  });

  assert.equal(result.ok, true);
  assert.equal(result.config.glookoTimezoneOffset, -7200000);
  assert.equal(result.config.glookoDeviceId, 'device-123');
  assert.equal(result.config.glookoSerialNumber, 'serial-123');
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
