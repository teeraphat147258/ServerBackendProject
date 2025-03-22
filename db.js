const mysql = require('mysql');
const util = require('util');

const db = mysql.createConnection({
    host: '3.25.192.169',
    user: 'TeeraphatIce',
    password: 'Ice12112545*',
    database: 'sensor_db'
});

db.connect(err => {
    if (err) {
        console.log('Error connecting to MySQL:', err);
        process.exit(1); // Exit on failure
    }
    console.log('Connected to MySQL');
});

db.query = util.promisify(db.query);

module.exports = db;
