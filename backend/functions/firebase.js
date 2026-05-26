const admin = require("firebase-admin");
admin.initializeApp();

const database = admin.firestore();
database.settings({
    databaseId:"mintmotor"
});

module.exports = {database};
