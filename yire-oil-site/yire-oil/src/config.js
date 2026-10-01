// Business rules the server enforces. The site's CONFIG shows the same values to customers,
// so if you change hours or timing here, change them in public/index.html too.
export const CONFIG = {
  tz: "America/New_York",
  baseZip: "33182",       // where the truck starts the day
  firstStart: "00:00",    // earliest appointment start
  lastStart: "23:30",     // latest appointment start
  slotStepMin: 30,        // start times offered every N minutes
  serviceMin: 30,         // time at a stop until he's ready to roll to the next one
  roadFactor: 1.25,       // roads are ~25% longer than a straight line
  avgMph: 45,             // fuel-truck average incl. traffic
  overheadMin: 10,        // getting in/out, parking, finding the slip
  departBaseAt: null,     // e.g. "08:00": first stop must be reachable from base by then
  openDays: [0, 1, 2, 3, 4, 5, 6], // 0 = Sunday
  bookAheadDays: 60,
  minLeadMin: 60,         // no booking that starts within the next hour
  depositCents: 5000,     // $50.00
  holdMinutes: 30,        // how long a slot is held while the customer is on Square's checkout
  rescheduleCutoffHours: 12, // customers can move their time online until this long before it
  maxReschedules: 2       // online time changes per booking (the driver isn't limited)
};
