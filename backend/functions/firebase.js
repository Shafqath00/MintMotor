const admin = require("firebase-admin");
admin.initializeApp();

const database = admin.firestore();
database.settings({
    databaseId: "mintmotor"
});

const storage = admin.storage();

module.exports = {admin, database, storage};
