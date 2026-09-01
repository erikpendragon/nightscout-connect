var moment = require('moment');
// One timezone implementation, shared with index.js. It uses Intl rather
// than moment-timezone, which was never a declared dependency here and
// resolved only by accident from the host's tree - when it did not, the
// old helper fell back to a fixed offset without saying so.
var tz = require('./timezone');


function generate_nightscout_treatments(batch, timestampDelta, timezone) {
      // Snack Bolus
      // Meal Bolus
      // BG Check
      // Correction Bolus
      // Carb Correction  
  /*
  var foods = entries['foods']['foods']; //ugh
  var insulins = entries['insulins']['insulins'];
  var pumpBoluses = entries['pumpBoluses']['normalBoluses']
  */
  const foods = batch.foods;
  const insulins = batch.insulins;
  const pumpBoluses = batch.normalBoluses;
  const scheduledBasals = batch.wideBasals || batch.scheduledBasals;
  
  var treatments = []
  
  if (foods) {
    foods.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      var f_date = new Date(element.timestamp);
      var f_s_date = new Date(f_date.getTime()  + timestampDelta - 45*60000);
      var f_e_date = new Date(f_date.getTime()  + timestampDelta + 45*60000);

      var now = moment(f_date); //todays date
      var end = moment(f_s_date); // another date
      var duration = moment.duration(now.diff(end));
      var minutes = duration.asMinutes();

      var i_date = new Date();
      var result = insulins.filter(function(el) {
          i_date = new Date(el.timestamp);
          var i_moment = moment(i_date);
          var duration = moment.duration(now.diff(i_moment));
          var minutes = duration.asMinutes();
          return Math.abs(minutes) < 46;

      })
      

      insulin = result[0];
      if (insulin != undefined) {
        var i_date = moment(insulin.timestamp);
        treatment.eventType = 'Meal Bolus';
        // 4 hours * 60 minutes per hour * 60 seconds per minute * 1000 millseconds
        treatment.eventTime = new Date(i_date ).toISOString( );
        //treatment.eventTime = new Date(i_date).toISOString( );
        //treatment.eventTime = i_date.toISOString( );
        treatment.insulin = insulin.value;
        

        treatment.preBolus = moment.duration(moment(f_date).diff(moment(i_date))).asMinutes();
      } else {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Carb Correction';
        treatment.eventTime = new Date(f_date ).toISOString( );
        //treatment.eventTime = new Date(f_date).toISOString( );
        //treatment.eventTime = f_date.toISOString( );
      }

      treatment.carbs = element.carbs;
      
      treatments.push(treatment);
      //console.log(treatment)

    });    
  }

  if (insulins) {
    insulins.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      var f_date = new Date(element.timestamp);
      var f_s_date = new Date(f_date.getTime() + timestampDelta - 45*60000);
      var f_e_date = new Date(f_date.getTime() + timestampDelta + 45*60000);

      var now = moment(f_date); //todays date
      var end = moment(f_s_date); // another date
      var duration = moment.duration(now.diff(end));
      var minutes = duration.asMinutes();

      var i_date = new Date();
      var result = foods.filter(function(el) {
          i_date = new Date(el.timestamp);
          var i_moment = moment(i_date);
          var duration = moment.duration(now.diff(i_moment));
          var minutes = duration.asMinutes();
          return Math.abs(minutes) < 46;

      })
      //console.log(result);
      if (result[0] == undefined) {
        var f_date = moment(element.timestamp);
        treatment.eventType = 'Correction Bolus';
        treatment.eventTime = new Date(f_date).toISOString( );
        treatment.insulin = element.value;
        //treatment.eventTime = f_date.toISOString( );
        treatments.push(treatment);
      }
    });    
  }

  if (pumpBoluses) {
    pumpBoluses.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      
      var f_date = moment(element.pumpTimestamp);
      // A bolus with no carbs is a correction, not a meal. Labelling every
      // pump bolus 'Meal Bolus' makes the two indistinguishable in the log
      // and inflates anything that counts meals.
      var carbs = Number(element.carbsInput) || 0;
      treatment.eventType = carbs > 0 ? 'Meal Bolus' : 'Correction Bolus';
      treatment.eventTime = tz.timestampWithOffset(element.pumpTimestamp, timestampDelta, timezone).toISOString( );
      treatment.insulin = element.insulinDelivered;
      if (carbs > 0) treatment.carbs = carbs;
      // Boluses were the one collection not carrying their guid, so the dedup
      // filter could never match one and the wide fetch re-offered every bolus
      // in the window on every cycle. Identical re-posts collapsed, which hid
      // it - until the eventType changed and the same bolus landed a second
      // time under a different name.
      treatment.glookoGuid = element.guid;
      treatments.push(treatment);
    })
  }

  /*

  {
    "_id": "6481762cd06cbb6e6c06a6b7",
    "duration": 30,
    "timestamp": "2023-06-08T09:31:35+03:00",
    "absolute": 0,
    "rate": 0,
    "eventType": "Temp Basal",
    "medtronic": "mm://openaps/mm-format-ns-treatments/Temp Basal",
    "created_at": "2023-06-08T09:31:35.000+03:00",
    "enteredBy": "openaps://medtronic/"
  }
  
    {
      pumpTimestamp: '2023-06-15T12:07:30.000Z',
      pumpTimestampUtcOffset: '+00:00',
      pumpGuid: '520dd015-1b04-410b-8962-35d78b4a90e8',
      syncTimestamp: '2023-06-15T10:24:45.184Z',
      startTime: 43650,
      duration: 4582,
      segmentId: null,
      rate: 0,
      guid: 'dc335f52-0b66-11ee-ab49-0242ac110002',
      softDeleted: false,
      updatedAt: '2023-06-15T10:24:50.380Z',
      updatedBy: 'server'
    }
  */
  if (scheduledBasals) {
    scheduledBasals.forEach(function(element) {
      var treatment = {};

      //console.log(element);
      
      var f_date = moment(element.pumpTimestamp);
      treatment.eventType = 'Temp Basal';
      treatment.created_at = tz.timestampWithOffset(element.pumpTimestamp, timestampDelta, timezone).toISOString( );
      treatment.rate = element.rate;
      treatment.absolute = element.rate;
      treatment.duration = Math.round(element.duration / 6) / 10;  // seconds -> minutes
      treatment.glookoGuid = element.guid;
      //treatment.eventTime = f_date.toISOString( );
      treatments.push(treatment);
    })
  }

  // Pod and reservoir events, straight from the pump's own record - this is
  // what feeds Nightscout's CAGE/IAGE counters. pod_activating is the moment
  // the new pod starts, which is what "site change" means for Omnipod.
  const pumpEvents = batch.pumpEvents;
  if (pumpEvents) {
    const EVENT_MAP = {
      pod_activating: 'Site Change',
      reservoir_change: 'Insulin Change',
      cgm_sensor_change: 'Sensor Start'
    };
    pumpEvents.forEach(function (element) {
      const eventType = EVENT_MAP[element.type];
      if (!eventType) { return; }
      var treatment = {};
      var f_date = moment(element.pumpTimestamp);
      treatment.eventType = eventType;
      // eventTime, not created_at - Nightscout only derives `mills` from the
      // former, and clients rely on mills to age a treatment
      treatment.eventTime = tz.timestampWithOffset(element.pumpTimestamp, timestampDelta, timezone).toISOString( );
      treatment.glookoGuid = element.guid;
      treatments.push(treatment);
    })
  }

  // Glooko alarms. `alarm_type` is always null - the machine-readable code
  // lives in `value`. Imported as Note (never Announcement) so they land on
  // the graph and in the log WITHOUT Nightscout raising notifications for
  // them: this is a record, not an alerting system.
  const ALARM_TEXT = {
    // device health - nothing else surfaces these
    omnipod_exit_close_loop: 'Left automated mode',
    omnipod_twelve_missing_egv: 'Pump lost CGM feed',
    omnipod_low_reservoir: 'Low reservoir',
    omnipod_pod_expiration: 'Pod expired',
    omnipod_pod_expiration_imminent: 'Pod expiring soon',
    omnipod_pod_expire_at_user_set_time: 'Pod expiry reminder',
    omnipod_pump_expired: 'Pod expired',
    dexcom_signal_loss: 'Sensor signal lost',
    dexcom_brief_sensor_issue: 'Brief sensor issue',
    // glucose thresholds - Dexcom Follow already alarms on these, so they are
    // here only to be drawn on the graph
    dexcom_low_glucose_alert: 'Low glucose',
    dexcom_high_glucose_alert: 'High glucose',
    dexcom_urgent_low_alert: 'Urgent low',
    dexcom_urgent_low_soon: 'Urgent low predicted',
    dexcom_falling_fast_alert: 'Falling fast',
    dexcom_rising_fast_alert: 'Rising fast',
    omnipod_urgent_low_glucose: 'Urgent low (pump)'
  };
  const DEVICE_CODES = {
    omnipod_exit_close_loop: 1, omnipod_twelve_missing_egv: 1,
    omnipod_low_reservoir: 1, omnipod_pod_expiration: 1,
    omnipod_pod_expiration_imminent: 1, omnipod_pod_expire_at_user_set_time: 1,
    omnipod_pump_expired: 1, dexcom_signal_loss: 1,
    dexcom_brief_sensor_issue: 1
  };
  const pumpAlarms = batch.pumpAlarms;
  if (pumpAlarms) {
    pumpAlarms.forEach(function (a) {
      if (!a.value) { return; }
      var text = ALARM_TEXT[a.value] || String(a.value).replace(/_/g, ' ');
      var treatment = {};
      treatment.eventType = 'Note';
      treatment.eventTime = tz.timestampWithOffset(a.pump_timestamp, timestampDelta, timezone).toISOString( );
      treatment.notes = text;
      treatment.enteredBy = 'glooko-alarm';
      treatment.glookoGuid = a.guid;
      // parsed by the display: severity, whether it is a device fault, and the
      // raw code so an unmapped one is still identifiable
      treatment.glookoAlarm = {
        code: a.value,
        severity: a.alarm_severity || 'alert',
        device: DEVICE_CODES[a.value] ? true : false
      };
      treatments.push(treatment);
    })
  }

  // Logged food. Deliberately a Note and NOT a carb treatment: the bolus
  // already carries carbsInput for the same meal, and a second carb entry
  // would double-count into COB. This adds what was eaten, not how much.
  const glookoFoods = batch.glookoFoods;
  if (glookoFoods) {
    glookoFoods.forEach(function (f) {
      if (!f.name) { return; }
      var parts = [];
      if (f.carbs)   parts.push(Math.round(f.carbs) + 'g carb');
      if (f.protein) parts.push(Math.round(f.protein) + 'g protein');
      if (f.fat)     parts.push(Math.round(f.fat) + 'g fat');
      var treatment = {};
      treatment.eventType = 'Note';
      treatment.eventTime = tz.timestampWithOffset(f.timestamp, timestampDelta, timezone).toISOString( );
      treatment.notes = f.name + (parts.length ? ' (' + parts.join(', ') + ')' : '');
      treatment.enteredBy = 'glooko-food';
      treatment.glookoGuid = f.guid;
      treatments.push(treatment);
    })

    // Compare what was logged against what was actually dosed for. These are
    // two different numbers for one meal, and the gap is the interesting part:
    // it is invisible in either record alone and shows up later as an
    // unexplained post-meal high.
    var boluses = batch.correlationBoluses || batch.normalBoluses || [];
    var WINDOW = 20 * 60 * 1000;
    var clusters = [];
    glookoFoods.slice().sort(function (a, b) {
      return new Date(a.timestamp) - new Date(b.timestamp);
    }).forEach(function (f) {
      var t = new Date(f.timestamp).getTime();
      var last = clusters[clusters.length - 1];
      if (last && t - last.last <= WINDOW) {
        last.carbs += (f.carbs || 0); last.last = t; last.names.push(f.name);
      } else {
        clusters.push({ first: t, last: t, carbs: (f.carbs || 0), names: [f.name], guid: f.guid });
      }
    });
    clusters.forEach(function (cl) {
      var best = null, bestGap = Infinity;
      boluses.forEach(function (b) {
        if (!b.carbsInput || !b.pumpTimestamp) { return; }
        var gap = Math.abs(new Date(b.pumpTimestamp).getTime( ) - cl.first);
        if (gap < bestGap && gap <= WINDOW) { bestGap = gap; best = b; }
      });
      if (!best) { return; }
      var logged = Math.round(cl.carbs), dosed = Math.round(best.carbsInput);
      if (Math.abs(logged - dosed) < 10) { return; }   // rounding, not a gap
      var t2 = {};
      t2.eventType = 'Note';
      t2.eventTime = tz.timestampWithOffset(best.pumpTimestamp, timestampDelta, timezone).toISOString( );
      t2.notes = 'Carb gap: bolused for ' + dosed + 'g, logged ' + logged + 'g ('
               + (logged > dosed ? (logged - dosed) + 'g short' : (dosed - logged) + 'g over') + ')';
      t2.enteredBy = 'glooko-carbgap';
      t2.glookoGuid = 'carbgap-' + cl.guid;
      treatments.push(t2);
    });
  }

  console.log('GLOOKO data transformation complete, returning', treatments.length, 'treatments');

  return treatments;
}

// Glooko reports the pump's own insulin-on-board with each bolus and the
// treatment path throws it away, so Nightscout's IOB pill has nothing behind
// it. This turns the newest reading into a devicestatus record - the same
// shape Nightscout's own pump uploaders write, so the existing plugin picks
// it up with no further work.
//
// Only the newest bolus carrying a value is emitted: IOB is a snapshot, not a
// per-treatment fact, and posting one per bolus would fill devicestatus with
// stale figures. `created_at` is the bolus timestamp rather than now, so a
// batch seen twice produces an identical record instead of a false later
// reading.
function generate_nightscout_devicestatus (batch, timestampDelta, timezone) {
  const pumpBoluses = batch && batch.normalBoluses;
  if (!pumpBoluses || !pumpBoluses.length) return [ ];

  var newest = null;
  pumpBoluses.forEach(function (element) {
    if (element == null) return;
    var iob = Number(element.insulinOnBoard);
    if (!isFinite(iob) || iob < 0) return;            // absent, or not a number
    if (!element.pumpTimestamp) return;
    var when = tz.timestampWithOffset(element.pumpTimestamp, timestampDelta, timezone);
    if (!newest || when > newest.when) newest = { when: when, element: element, iob: iob };
  });
  if (!newest) return [ ];

  var stamp = newest.when.toISOString( );
  return [ {
    device: 'glooko' + (newest.element.pumpName ? ' (' + newest.element.pumpName + ')' : ''),
    created_at: stamp,
    pump: {
      clock: stamp,
      iob: { iob: newest.iob, timestamp: stamp }
    }
  } ];
}


// ---------------------------------------------------------------------------
// Pump settings -> Nightscout profile
//
// Glooko's /api/v3/devices_and_settings carries the pump's own therapy
// settings: carb ratio, correction factor, targets, basal schedule and insulin
// duration. Nightscout keeps the same numbers in a profile, and most people
// type them in by hand - which is how the two drift apart without anyone
// noticing.
//
// The settings arrive keyed by device guid and then by an ISO timestamp, one
// entry per time a clinician changed something. The newest is the live one.
//
// Values are in the Glooko account's display units. Nothing is converted here;
// the units are recorded on the profile and Nightscout does its own conversion.

function pad2 (n) { return (n < 10 ? '0' : '') + n; }

// segmentStart is in hours and may be fractional - 6.5 means 06:30.
function segment_time (startHours) {
  var total = Math.round(Number(startHours) * 3600);
  if (!isFinite(total) || total < 0 || total >= 86400) return null;
  return { time: pad2(Math.floor(total / 3600)) + ':' + pad2(Math.floor((total % 3600) / 60))
         , timeAsSeconds: total };
}

// Every Glooko schedule block has the same shape:
//   { profileName, current, dailyTotal, data: [ { segmentStart, duration, value } ] }
function schedule_from (block, pick) {
  if (!block || !Array.isArray(block.data)) return null;
  var out = [ ];
  block.data.forEach(function (seg) {
    if (!seg) return;
    var when = segment_time(seg.segmentStart);
    if (!when) return;
    // Number(null) and Number('') are both 0. A missing value must not become
    // a zero carb ratio or a zero target - those are divide-by-zero and a
    // dose against nothing. A genuine zero basal segment is legitimate, so
    // only absent values are rejected here, not zero itself.
    var raw = pick ? pick(seg) : seg.value;
    if (raw === null || raw === undefined || raw === '') return;
    var value = Number(raw);
    if (!isFinite(value) || value < 0) return;
    out.push({ time: when.time, timeAsSeconds: when.timeAsSeconds, value: value });
  });
  if (!out.length) return null;
  out.sort(function (a, b) { return a.timeAsSeconds - b.timeAsSeconds; });
  return out;
}

// targetBgSegments carry value alongside valueLow/valueHigh. A pump set to a
// single target reports the range fields as zero, and then both Nightscout
// bounds take the point value.
function target_bounds (block) {
  function bound (field) {
    return schedule_from(block, function (seg) {
      var v = Number(seg[field]);
      return isFinite(v) && v > 0 ? v : seg.value;
    });
  }
  return { low: bound('valueLow'), high: bound('valueHigh') };
}

// deviceSettings.pumps is { <deviceGuid>: { <ISO timestamp>: snapshot } }.
function newest_snapshot (deviceSettings, activePumpGuid) {
  var pumps = deviceSettings && deviceSettings.pumps;
  if (!pumps || typeof pumps !== 'object') return null;
  var guids = Object.keys(pumps);
  if (!guids.length) return null;
  var guid = (activePumpGuid && pumps[activePumpGuid]) ? activePumpGuid : guids[0];
  var stamps = Object.keys(pumps[guid] || { }).sort();
  if (!stamps.length) return null;
  var stamp = stamps[stamps.length - 1];
  return { guid: guid, stamp: stamp, settings: pumps[guid][stamp] };
}

// profilesBolus and pumpProfilesBasal are arrays. The `current` flag sits on
// the schedule blocks inside each entry, not on the entry itself.
function pick_current (list) {
  if (!Array.isArray(list) || !list.length) return null;
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry) continue;
    var flagged = Object.keys(entry).some(function (k) {
      return entry[k] && entry[k].current;
    });
    if (flagged) return entry;
  }
  return list[0];
}

function generate_nightscout_profile (deviceSettings, opts) {
  opts = opts || { };
  var found = newest_snapshot(deviceSettings, opts.activePumpGuid);
  if (!found || !found.settings) return [ ];

  var settings = found.settings;
  var bolus = pick_current(settings.profilesBolus);
  var basalProfile = pick_current(settings.pumpProfilesBasal);

  var carbratio = bolus ? schedule_from(bolus.insulinToCarbRatioSegments) : null;
  var sens = bolus ? schedule_from(bolus.isfSegments) : null;
  var basal = basalProfile ? schedule_from(basalProfile.segments) : null;
  var targets = bolus ? target_bounds(bolus.targetBgSegments) : { low: null, high: null };

  // A profile with no schedules is worse than no profile at all - Nightscout
  // would render zeroes and the bolus wizard would quietly dose against them.
  if (!carbratio && !sens && !basal) return [ ];

  var when = new Date(found.stamp);
  if (isNaN(when.getTime( ))) when = new Date( );
  var stamp = when.toISOString( );

  var dia = Number((settings.generalSettings || { }).activeInsulinTime);
  var name = opts.profileName || 'Pump';
  var store = { };

  store[name] = {
    dia: isFinite(dia) && dia > 0 ? dia : (opts.defaultDia || 3)
  , carbratio: carbratio || [ ]
  , sens: sens || [ ]
  , basal: basal || [ ]
  , target_low: targets.low || [ ]
  , target_high: targets.high || [ ]
  , carbs_hr: String(opts.carbsPerHour == null ? 20 : opts.carbsPerHour)
  , delay: String(opts.delay == null ? 20 : opts.delay)
  , timezone: opts.timezone || ''
  , units: opts.units || ''
  , startDate: '1970-01-01T00:00:00.000Z'
  };

  return [ {
    defaultProfile: name
  , store: store
  , startDate: stamp
  , mills: String(when.getTime( ))
  , units: opts.units || ''
  , created_at: stamp
    // identifies the settings snapshot this came from, so a re-import of the
    // same one is recognisable and a genuinely new one is not mistaken for it
  , glookoGuid: 'devicesettings-' + found.guid + '-' + found.stamp
  } ];
}


// In propose mode the profile is not written. This says what the pump actually
// holds so a person can compare it against Nightscout themselves and decide.
// It carries the snapshot guid, so it appears once per clinician change rather
// than once per poll.
function generate_settings_note (deviceSettings, opts) {
  var profiles = generate_nightscout_profile(deviceSettings, opts);
  if (!profiles.length) return [ ];

  var doc = profiles[0];
  var store = doc.store[doc.defaultProfile];
  var units = store.units ? ' ' + store.units : '';
  var parts = [ ];

  function summarise (schedule, label, suffix) {
    if (!schedule || !schedule.length) return;
    var more = schedule.length > 1 ? ' (+' + (schedule.length - 1) + ' more)' : '';
    parts.push(label + ' ' + schedule[0].value + (suffix || '') + more);
  }

  if (store.dia) parts.push('DIA ' + store.dia + ' h');
  summarise(store.carbratio, 'carb ratio', ' g/U');
  summarise(store.sens, 'correction', units ? units + '/U' : '');
  summarise(store.target_low, 'target', units);
  summarise(store.basal, 'basal', ' U/h');
  if (!parts.length) return [ ];

  // Dated now, not at the snapshot. The settings may have been changed months
  // ago, and a note written three months back sits where nobody scrolls - so
  // it would be posted, correct, and never seen. The date the pump was last
  // changed goes in the text instead, where it is the useful part anyway.
  var changed = doc.created_at.slice(0, 10);
  var treatment = { };
  treatment.eventType = 'Note';
  treatment.eventTime = new Date( ).toISOString( );
  treatment.notes = 'Pump settings (last changed ' + changed + '): ' + parts.join(', ');
  treatment.enteredBy = 'glooko-settings';
  treatment.glookoGuid = doc.glookoGuid + '-note';
  return [ treatment ];
}

module.exports.generate_nightscout_treatments = generate_nightscout_treatments;
module.exports.generate_nightscout_devicestatus = generate_nightscout_devicestatus;
module.exports.generate_nightscout_profile = generate_nightscout_profile;
module.exports.generate_settings_note = generate_settings_note;
