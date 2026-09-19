// Give the two local DMS demo accounts working bcrypt passwords.
//
// NOT an authentication bypass: these are ordinary users with ordinary hashes,
// checked by the credentials provider exactly like anyone else's. The demo
// panel on the login page only fills the form.
//
// Both already own seeded data, so signing in as either lands on a dashboard
// with something on it.

const ADMIN_HASH = "$2b$10$O3m92SqvmmRGyHmjTzaInuoFnmpLFROFH5n8Wr5v2yz8BDg/xH7ja"; // DemoAdmin@2026
const USER_HASH  = "$2b$10$lnNOG/I1zviu975NQG/s/OO.iMEZ0dMXOT.19Mi4Wv1t7qWVgLOkW"; // DemoUser@2026

// The gates the credentials provider checks before it ever compares a password.
const GATES = {
  isActive: true,
  isActivated: true,
  isDeleted: false,
  totpEnabled: false,
};

db.users.updateOne(
  { email: "dev-local@anutech.invalid" },
  { $set: Object.assign({ password: ADMIN_HASH, role: "admin", updatedAt: new Date() }, GATES) }
);

db.users.updateOne(
  { email: "testcustomer@local.invalid" },
  { $set: Object.assign({ password: USER_HASH, role: "user", updatedAt: new Date() }, GATES) }
);

print("--- result ---");
db.users
  .find({}, { email: 1, role: 1, isActive: 1, isActivated: 1, password: 1, _id: 0 })
  .forEach((u) =>
    print(
      `${u.email}  role=${u.role}  active=${u.isActive}  activated=${u.isActivated}  password=${
        u.password ? "set" : "NONE"
      }`
    )
  );
