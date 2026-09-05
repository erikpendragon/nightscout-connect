const assert = require('node:assert/strict');
const test = require('node:test');

const helper = require('../lib/sources/glooko/convert');

// Shaped like /api/v3/devices_and_settings, with invented values.
function settingsFixture (overrides) {
  const snapshot = Object.assign({
    generalSettings: { activeInsulinTime: 4, activeCgm: 'DEXCOM_G7' }
  , bolusSettings: { bolusReverseCorrectionEnabled: false, maxBolus: 10 }
  , basalSettings: { maxBasalRate: 3.5, activeBasalProgram: 'Basal 1' }
  , cgmSettings: { }
  , profilesBolus: [ {
      isfSegments: { profileName: 'Profile', current: true, data: [ { segmentStart: 0, duration: 24, value: 3.7 } ] }
    , targetBgSegments: { profileName: 'Profile', current: true, data: [ { segmentStart: 0, duration: 24, value: 6.7, valueLow: 0, valueHigh: 0 } ] }
    , insulinToCarbRatioSegments: { profileName: 'Profile', current: true, data: [ { segmentStart: 0, duration: 24, value: 12 } ] }
    , bgCorrectionThresholdSegments: { profileName: 'Profile', current: true, data: [ { segmentStart: 0, duration: 24, value: 6.7 } ] }
    } ]
  , pumpProfilesBasal: [ {
      segments: { profileName: 'Basal 1', current: true, dailyTotal: 13.2, data: [ { segmentStart: 0, duration: 24, value: 0.55 } ] }
    } ]
  }, overrides || { });

  return { activePumpGuid: 'pump-a'
         , pumps: { 'pump-a': { '2026-02-10T21:28:45.968Z': { generalSettings: { activeInsulinTime: 3 } }
                              , '2026-06-03T16:58:01.427Z': snapshot } }
         , meters: { } };
}

test('builds a Nightscout profile from the newest settings snapshot', () => {
  const [ profile ] = helper.generate_nightscout_profile(settingsFixture(), { units: 'mmol', timezone: 'America/Toronto' });
  const store = profile.store[profile.defaultProfile];

  assert.equal(profile.defaultProfile, 'Pump');
  assert.equal(store.dia, 4, 'takes DIA from the newest snapshot, not the oldest');
  assert.deepEqual(store.carbratio, [ { time: '00:00', timeAsSeconds: 0, value: 12 } ]);
  assert.deepEqual(store.sens, [ { time: '00:00', timeAsSeconds: 0, value: 3.7 } ]);
  assert.deepEqual(store.basal, [ { time: '00:00', timeAsSeconds: 0, value: 0.55 } ]);
  assert.equal(store.units, 'mmol');
  assert.equal(store.timezone, 'America/Toronto');
  assert.equal(profile.startDate, '2026-06-03T16:58:01.427Z');
});

test('a point target fills both Nightscout bounds', () => {
  const [ profile ] = helper.generate_nightscout_profile(settingsFixture(), { units: 'mmol' });
  const store = profile.store.Pump;
  assert.deepEqual(store.target_low, [ { time: '00:00', timeAsSeconds: 0, value: 6.7 } ]);
  assert.deepEqual(store.target_high, [ { time: '00:00', timeAsSeconds: 0, value: 6.7 } ]);
});

test('a real range is preserved when the pump reports one', () => {
  const fixture = settingsFixture({
    profilesBolus: [ {
      isfSegments: { current: true, data: [ { segmentStart: 0, duration: 24, value: 3.7 } ] }
    , targetBgSegments: { current: true, data: [ { segmentStart: 0, duration: 24, value: 0, valueLow: 4.5, valueHigh: 8.0 } ] }
    , insulinToCarbRatioSegments: { current: true, data: [ { segmentStart: 0, duration: 24, value: 12 } ] }
    } ]
  });
  const store = helper.generate_nightscout_profile(fixture, { })[0].store.Pump;
  assert.equal(store.target_low[0].value, 4.5);
  assert.equal(store.target_high[0].value, 8.0);
});

test('time-of-day segments convert, including half hours, and sort', () => {
  const fixture = settingsFixture({
    pumpProfilesBasal: [ { segments: { current: true, data: [
      { segmentStart: 22, duration: 2, value: 0.8 }
    , { segmentStart: 6.5, duration: 15.5, value: 0.6 }
    , { segmentStart: 0, duration: 6.5, value: 0.45 }
    ] } } ]
  });
  const store = helper.generate_nightscout_profile(fixture, { })[0].store.Pump;
  assert.deepEqual(store.basal, [
    { time: '00:00', timeAsSeconds: 0, value: 0.45 }
  , { time: '06:30', timeAsSeconds: 23400, value: 0.6 }
  , { time: '22:00', timeAsSeconds: 79200, value: 0.8 }
  ]);
});

test('emits nothing rather than a profile full of zeroes', () => {
  assert.deepEqual(helper.generate_nightscout_profile({ pumps: { p: { '2026-01-01T00:00:00.000Z': { generalSettings: { activeInsulinTime: 4 } } } } }, { }), [ ]);
  assert.deepEqual(helper.generate_nightscout_profile({ pumps: { } }, { }), [ ]);
  assert.deepEqual(helper.generate_nightscout_profile(null, { }), [ ]);
  assert.deepEqual(helper.generate_nightscout_profile({ }, { }), [ ]);
});

test('drops unusable segments instead of emitting NaN', () => {
  const fixture = settingsFixture({
    profilesBolus: [ { insulinToCarbRatioSegments: { current: true, data: [
      { segmentStart: 0, duration: 12, value: 12 }
    , { segmentStart: 'noon', duration: 12, value: 10 }
    , { segmentStart: 18, duration: 6, value: null }
    , { segmentStart: 25, duration: 1, value: 9 }
    ] } } ]
  });
  const store = helper.generate_nightscout_profile(fixture, { })[0].store.Pump;
  assert.deepEqual(store.carbratio, [ { time: '00:00', timeAsSeconds: 0, value: 12 } ]);
});

test('carries a stable identifier for the snapshot it came from', () => {
  const a = helper.generate_nightscout_profile(settingsFixture(), { })[0];
  const b = helper.generate_nightscout_profile(settingsFixture(), { })[0];
  assert.equal(a.glookoGuid, b.glookoGuid, 'same snapshot yields the same id');
  assert.match(a.glookoGuid, /^devicesettings-pump-a-2026-06-03T16:58:01\.427Z$/);
});

test('follows activePumpGuid when more than one pump is present', () => {
  const fixture = settingsFixture();
  fixture.pumps['pump-b'] = { '2026-07-01T00:00:00.000Z': {
    generalSettings: { activeInsulinTime: 9 }
  , profilesBolus: [ { insulinToCarbRatioSegments: { current: true, data: [ { segmentStart: 0, duration: 24, value: 99 } ] } } ]
  } };
  const store = helper.generate_nightscout_profile(fixture, { })[0].store.Pump;
  assert.equal(store.carbratio[0].value, 12, 'ignores the newer non-active pump');
  assert.equal(store.dia, 4);
});

// --- wiring: the three profile-sync modes -----------------------------------

const glookoSource = require('../lib/sources/glooko');

function fakeAxios (handler) {
  return {
    create () {
      return {
        get (path, options) { return handler({ method: 'get', path, options }); },
        post (path, body, options) { return handler({ method: 'post', path, body, options }); }
      };
    }
  };
}

function sourceWith (mode) {
  return glookoSource({
    glookoEmail: 'someone@example.com'
  , glookoPassword: 'secret'
  , glookoServer: 'api.glooko.com'
  , glookoTimezoneOffset: 0
  , glookoProfileSync: mode
  , glookoUnits: 'mmol'
  , baseURL: 'https://api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: { } })));
}

const batchWithSettings = {
  readings: [ ]
  // shaped like the /api/v3/devices_and_settings response, which nests the
  // schedule tree one level down under its own deviceSettings key
, deviceSettings: {
    activePumpGuid: 'pump-a'
  , deviceSettings: { meters: { }, pumps: { 'pump-a': { '2026-06-03T16:58:01.427Z': {
      generalSettings: { activeInsulinTime: 4 }
    , profilesBolus: [ {
        isfSegments: { current: true, data: [ { segmentStart: 0, duration: 24, value: 3.7 } ] }
      , insulinToCarbRatioSegments: { current: true, data: [ { segmentStart: 0, duration: 24, value: 12 } ] }
      , targetBgSegments: { current: true, data: [ { segmentStart: 0, duration: 24, value: 6.7, valueLow: 0, valueHigh: 0 } ] }
      } ]
    , pumpProfilesBasal: [ { segments: { current: true, data: [ { segmentStart: 0, duration: 24, value: 0.55 } ] } } ]
    } } } }
  }
};

test('override mode writes a profile', () => {
  const out = sourceWith('override').transformData(batchWithSettings);
  assert.equal(out.profiles.length, 1);
  const store = out.profiles[0].store[out.profiles[0].defaultProfile];
  assert.equal(store.dia, 4);
  assert.equal(store.carbratio[0].value, 12);
  assert.equal(store.units, 'mmol');
  assert.ok(!out.treatments.some((t) => t.enteredBy === 'glooko-settings'), 'no note in override mode');
});

test('propose mode writes a note and no profile', () => {
  const out = sourceWith('propose').transformData(batchWithSettings);
  assert.ok(!out.profiles, 'nothing is written to the profile');
  const note = out.treatments.find((t) => t.enteredBy === 'glooko-settings');
  assert.ok(note, 'a note describing the settings is posted');
  assert.equal(note.eventType, 'Note');
  assert.match(note.notes, /DIA 4 h/);
  assert.match(note.notes, /carb ratio 12 g\/U/);
  assert.match(note.glookoGuid, /-note$/);
});

test('off, and anything unrecognised, does neither', () => {
  for (const mode of [ 'off', undefined, '', 'yes', 'true' ]) {
    const out = sourceWith(mode).transformData(batchWithSettings);
    assert.ok(!out.profiles, 'no profile for mode ' + JSON.stringify(mode));
    assert.ok(!out.treatments.some((t) => t.enteredBy === 'glooko-settings'),
              'no note for mode ' + JSON.stringify(mode));
  }
});

test('a batch with no settings in it is harmless in every mode', () => {
  for (const mode of [ 'off', 'propose', 'override' ]) {
    const out = sourceWith(mode).transformData({ readings: [ ] });
    assert.ok(!out.profiles);
    assert.ok(Array.isArray(out.treatments));
  }
});

test('the note repeats for the same snapshot, so the output layer can dedupe it', () => {
  const a = sourceWith('propose').transformData(batchWithSettings);
  const b = sourceWith('propose').transformData(batchWithSettings);
  const noteA = a.treatments.find((t) => t.enteredBy === 'glooko-settings');
  const noteB = b.treatments.find((t) => t.enteredBy === 'glooko-settings');
  assert.equal(noteA.glookoGuid, noteB.glookoGuid);
});

test('a snapshot already reported is not reported again', () => {
  const guid = 'devicesettings-pump-a-2026-06-03T16:58:01.427Z';
  const seen = { ...batchWithSettings, seenGuids: new Set([ guid + '-note', guid ]) };

  const proposed = sourceWith('propose').transformData(seen);
  assert.ok(!proposed.treatments.some((t) => t.enteredBy === 'glooko-settings'),
            'the note is suppressed once Nightscout already has it');

  const overridden = sourceWith('override').transformData(seen);
  assert.ok(!overridden.profiles, 'an unchanged profile is not rewritten');
});

test('a new snapshot is reported even when older ones are known', () => {
  const seen = { ...batchWithSettings
               , seenGuids: new Set([ 'devicesettings-pump-a-2026-02-10T21:28:45.968Z-note' ]) };
  const out = sourceWith('propose').transformData(seen);
  assert.ok(out.treatments.some((t) => t.enteredBy === 'glooko-settings'),
            'a change the clinician made since is still surfaced');
});

test('the note is dated when it is written, not when the pump changed', () => {
  const out = sourceWith('propose').transformData(batchWithSettings);
  const note = out.treatments.find((t) => t.enteredBy === 'glooko-settings');
  const age = Date.now() - new Date(note.eventTime).getTime();
  assert.ok(age >= 0 && age < 60000, 'stamped now, so it lands where people look');
  assert.match(note.notes, /last changed 2026-06-03/, 'the pump change date is in the text');
});

// --- pumps this driver does not understand ----------------------------------

// A settings response whose schedule tree is in a shape the converter does not
// recognise - which is what a pump other than the one this was written against
// may well look like.
const batchWithUnreadableSettings = {
  readings: [ ]
, deviceSettings: {
    activePumpGuid: 'pump-z'
  , devices: [ { type: 'pump', brand: 'Tandem', model: 't:slim X2', guid: 'pump-z' }
             , { type: 'cgm', brand: 'Dexcom', model: 'Dexcom' } ]
  , deviceSettings: { meters: { }, pumps: { 'pump-z': { '2026-06-03T16:58:01.427Z': {
      generalSettings: { activeInsulinTime: 5 }
    , somethingUnexpected: { schedules: [ ] }
    } } } }
  }
};

test('an unreadable pump says so, and names the pump', () => {
  const out = sourceWith('propose').transformData(batchWithUnreadableSettings);
  const note = out.treatments.find((t) => t.enteredBy === 'glooko-settings');
  assert.ok(note, 'the wearer is told rather than left guessing');
  assert.match(note.notes, /Tandem t:slim X2/, 'names the pump so it is actionable');
  assert.match(note.notes, /maintained by hand/);
  assert.ok(!out.profiles, 'and nothing is written');
});

test('override mode also reports a pump it cannot read', () => {
  const out = sourceWith('override').transformData(batchWithUnreadableSettings);
  assert.ok(out.treatments.some((t) => t.enteredBy === 'glooko-settings'));
  assert.ok(!out.profiles);
});

test('off mode stays silent even about a pump it could not read', () => {
  const out = sourceWith('off').transformData(batchWithUnreadableSettings);
  assert.ok(!out.treatments.some((t) => t.enteredBy === 'glooko-settings'));
});

test('the unreadable note is said once per pump, not once per poll', () => {
  const seen = { ...batchWithUnreadableSettings
               , seenGuids: new Set([ 'devicesettings-unreadable-pump-z' ]) };
  const out = sourceWith('propose').transformData(seen);
  assert.ok(!out.treatments.some((t) => t.enteredBy === 'glooko-settings'));
});

test('an unnamed pump still produces a usable message', () => {
  const anon = { readings: [ ]
               , deviceSettings: { deviceSettings: { pumps: { p: { '2026-01-01T00:00:00.000Z': { } } } } } };
  const out = sourceWith('propose').transformData(anon);
  const note = out.treatments.find((t) => t.enteredBy === 'glooko-settings');
  assert.ok(note);
  assert.match(note.notes, /the pump on this account/);
});

// A settings response deliberately keyed by the things that must never be
// reported - a device guid, a snapshot timestamp, a serial, a numeric id - and
// carrying a value that must never be reported either.
const batchWithHostileKeys = {
  readings: [ ]
, deviceSettings: {
    activePumpGuid: 'pump-h'
  , devices: [ { type: 'pump', brand: 'Acme', model: 'Model One', guid: 'pump-h' } ]
  , deviceSettings: { pumps: { 'pump-h': { '2026-06-03T16:58:01.427Z': {
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890': { nestedBelowAGuid: 1 }
    , 'SN12345678': { nestedBelowASerial: 2 }
    , '9912345': { nestedBelowAnId: 3 }
    , wearerName: 'Jane Doe'
    , unknownSettings: { schedules: [ ] }
    } } } }
  }
};

test('the unreadable note carries the field names so somebody can add support', () => {
  const out = sourceWith('propose').transformData(batchWithUnreadableSettings);
  const note = out.treatments.find((t) => t.enteredBy === 'glooko-settings');
  assert.match(note.notes, /field names only, no values/, 'says plainly what it is');
  [ 'generalSettings', 'activeInsulinTime', 'somethingUnexpected', 'schedules' ]
    .forEach((name) => assert.ok(note.notes.includes(name), 'reports ' + name));
});

test('the field names never carry a guid, a timestamp, a serial or a value', () => {
  const out = sourceWith('propose').transformData(batchWithHostileKeys);
  const note = out.treatments.find((t) => t.enteredBy === 'glooko-settings');
  [ 'a1b2c3d4', 'e5f6', '2026-06-03', '16:58', 'SN12345678', '9912345', 'Jane Doe' ]
    .forEach((leak) => assert.ok(!note.notes.includes(leak), 'must not report ' + leak));
  assert.ok(note.notes.includes('unknownSettings'), 'but the real shape is still reported');
  assert.ok(note.notes.includes('nestedBelowAGuid'),
            'and a guid-keyed level is walked through rather than dropped');
});

test('the field name list is capped so the note stays readable', () => {
  const wide = { };
  for (let i = 0; i < 90; i++) { wide['fieldNumber' + String.fromCharCode(97 + i % 26) + i % 3] = i; }
  const batch = { readings: [ ]
                , deviceSettings: { activePumpGuid: 'pump-w'
                  , devices: [ { type: 'pump', brand: 'Acme', model: 'Wide', guid: 'pump-w' } ]
                  , deviceSettings: { pumps: { 'pump-w': { '2026-06-03T00:00:00.000Z': wide } } } } };
  const out = sourceWith('propose').transformData(batch);
  const note = out.treatments.find((t) => t.enteredBy === 'glooko-settings');
  assert.ok(note.notes.length < 1600, 'a timeline note nobody can read helps nobody');
});
