const express = require('express');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const swaggerDocs = require('./swagger'); // Ensure this file exists and is configured correctly
const mqtt = require('mqtt');
const db = require('./db'); // Ensure this is your DB connection

// MQTT Broker (replace with your EC2 MQTT broker IP if self-hosted)
const mqttBroker = 'mqtt://3.25.192.169'; // Public broker for testing
const mqttClient = mqtt.connect(mqttBroker);

const app = express();
const port = 3000;
const cors = require('cors');
app.use(cors());
app.use(express.json()); // This will parse the incoming JSON data
app.use(express.urlencoded({ extended: true })); // For parsing form data (if needed)

mqttClient.on('connect', () => {
    console.log('✅ Connected to MQTT Broker');
});

// Handle errors
mqttClient.on('error', (err) => {
    console.error('❌ MQTT Connection Error:', err);
});

// Subscribe to device status updates
mqttClient.subscribe('room/+/+/+', (err) => {
    if (!err) {
        console.log('📡 Subscribed to relevant topics');
    }
});

// Middleware to serve static files
app.use('/public', express.static(path.join(__dirname, 'public')));

// Swagger documentation setup
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));
console.log('Swagger docs available at http://localhost:3000/api-docs');

mqttClient.on('message', (topic, message) => {
    console.log(`📩 Received MQTT Message on ${topic}: ${message.toString()}`);

    const topicParts = topic.split('/'); // Example: ["room", "device", "1", "status"]
    const category = topicParts[1];  // "device" or "sensor"
    const device_id = topicParts[2]; // Extract roomID or deviceID
    const messageStr = message.toString().trim(); // Convert message to string and remove extra spaces
    // console.log(messageStr)
    // ✅ Device Status Update (Raw String)
    if (category === 'device' && topicParts[3] === 'status') {
        const deviceStatus = messageStr; // Directly use the raw string
        // console.log(deviceStatus , device_id)
        db.query("UPDATE device SET deviceStatus = ? WHERE deviceID = ?", [deviceStatus, device_id])
            .then(() => console.log(`✅ Updated device ${device_id} status in DB: ${deviceStatus}`))
            .catch((err) => console.error("❌ Database update error:", err));
    }

    // ✅ Sensor Data Insert (Raw String Expected Format: "pm25,co2,pressure,temperature,humidity")
    else if (category === 'sensor' && topicParts[3] === 'data') {
        const sensorValues = messageStr.split(','); // Example: "12.5,400,1013,22.5,45"
        
        if (sensorValues.length === 5) { // Ensure all values exist
            const [pm25, co2, pressure, temperature, humidity] = sensorValues.map(parseFloat);
            const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

            // db.query(
            //     "INSERT INTO air_quality (recorded_at, pm25, co2, pressure, temperature, humidity , device_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            //     [timestamp, pm25, co2, pressure, temperature, humidity , device_id]
            // )
            // .then(() => console.log(`✅ Inserted sensor data for deviceID ${device_id}`))
            // .catch((err) => console.error("❌ Sensor data insert error:", err));
        } else {
            console.error("❌ Invalid sensor data format:", messageStr);
        }
    }
});




app.set('mqttClient', mqttClient);

const usersRoutesPost = require('./routes/post');
const usersRoutesGet = require('./routes/get');
const usersRoutesPut = require('./routes/put');
const usersRoutesDelete = require('./routes/delete');

app.use('/get', usersRoutesGet);
app.use('/post', usersRoutesPost);
app.use('/put', usersRoutesPut);
app.use('/delete', usersRoutesDelete);
// Catch-all handler (optional, if you're not using Next.js)
// Uncomment if needed for custom routes
// app.all('*', (req, res) => {
//     res.status(404).send('Route not found');
// });


async function fetchAirQualityData() {
    // console.log('---------------------------START OF LOCAL HOST DEBUGGING--------------------------');
    try {
        const rows = await db.query(`
            SELECT aq.*, d.isOutside, d.deviceInRoom, d.deviceType
            FROM air_quality aq
            JOIN device d ON aq.device_id = d.deviceID
            WHERE d.isSensorDevice = 1
            AND aq.recorded_at >= NOW() - INTERVAL 1 MINUTE
            AND aq.recorded_at = (
                SELECT MAX(recorded_at) 
                FROM air_quality 
                WHERE device_id = aq.device_id 
                AND isOutside = d.isOutside
                AND recorded_at >= NOW() - INTERVAL 1 MINUTE
            )
            ORDER BY aq.recorded_at DESC;
        `);

        if (rows.length === 0) return; // ถ้าไม่มีข้อมูล ไม่ต้องทำอะไรต่อ

        const airData = rows.map(row => ({
            ...row,
            pressure: parseFloat(row.pressure),
        }));

        const inRoomAirData = airData.filter(row => row.isOutside === 0);
        const outRoomAirMap = new Map(
            airData.filter(row => row.isOutside === 1).map(row => [row.deviceInRoom, row])
        );

        const airDataWithDiffPressure = inRoomAirData.map(row => ({
            ...row,
            diffPressure: outRoomAirMap.has(row.deviceInRoom)
                ? parseFloat((row.pressure - outRoomAirMap.get(row.deviceInRoom).pressure).toFixed(2))
                : null
        }));

        const roomSettings = await db.query(`
            SELECT  room_id, 
                    diffPressure_threshold_high, 
                    diffPressure_threshold_low, 
                    temperature_threshold_high,
                    temperature_threshold_low,
                    humidity_threshold_high,
                    humidity_threshold_low,
                    pm25_threshold_high,
                    pm25_threshold_low,
                    co2_threshold_high,
                    co2_threshold_low,
                    auto_control_enabled 
            FROM rooms_setting 
            WHERE auto_control_enabled = 1
        `);

        const roomSettingMap = new Map(roomSettings.map(rs => [rs.room_id, rs]));

        const checkQualityWithSetting = airDataWithDiffPressure
            .map(row => ({
                ...row,
                ...roomSettingMap.get(row.deviceInRoom)
            }))
            .filter(row => row.deviceInRoom && row.auto_control_enabled);

        if (checkQualityWithSetting.length === 0) return;

        const insertQuery = `INSERT INTO air_quality_diff (recorded_at, pm25, co2, diffPressure, temperature, humidity, device_id) VALUES ?`;
        const values = checkQualityWithSetting.map(row => [
            row.recorded_at, row.pm25, row.co2, row.diffPressure, row.temperature, row.humidity, row.device_id
        ]);
        // await db.query(insertQuery, [values]);

        // ดึงข้อมูล device ในห้องเดียวกันในครั้งเดียว
        const deviceInRooms = await db.query(`
            SELECT deviceID, deviceType, deviceInRoom 
            FROM device 
            WHERE deviceInRoom IN (?)`,
            [checkQualityWithSetting.map(row => row.deviceInRoom)]
        );

        // จัดเก็บข้อมูลอุปกรณ์ใน Map
        const deviceInRoomMap = deviceInRooms.reduce((map, device) => {
            if (!map.has(device.deviceInRoom)) {
                map.set(device.deviceInRoom, []);
            }
            map.get(device.deviceInRoom).push(device);
            return map;
        }, new Map());

        // ตรวจสอบค่า PM2.5 และ DiffPressure เพื่อควบคุมอุปกรณ์
        for (let row of checkQualityWithSetting) {
            const devices = deviceInRoomMap.get(row.deviceInRoom) || [];
            console.log(row.pm25 , row.pm25_threshold_low)
            if (row.pm25 > row.pm25_threshold_high) {
                devices
                    .filter(device => device.deviceType === 'Air Purifier')
                    .forEach(device => {
                        mqttClient.publish(`room/device/${device.deviceID}/status`, 'on');
                    });
            }
            if(row.pm25 <= row.pm25_threshold_low){
                devices
                    .filter(device => device.deviceType === 'Air Purifier')
                    .forEach(device => {
                        mqttClient.publish(`room/device/${device.deviceID}/status`, 'off');
                    });
            }
            console.log(row.co2 , row.co2_threshold_high)
            if (row.co2 >= row.co2_threshold_high) {
                devices
                    .filter(device => device.deviceType === 'Exhaust fan')
                    .forEach(device => {
                        mqttClient.publish(`room/device/${device.deviceID}/status`, 'on');
                    });
            }
            if(row.co2 <= row.co2_threshold_low){
                devices
                    .filter(device => device.deviceType === 'Exhaust fan')
                    .forEach(device => {
                        mqttClient.publish(`room/device/${device.deviceID}/status`, 'off');
                    });
            }
        }
    } catch (err) {
        console.error('Error fetching air quality data:', err);
    } finally {
        // console.log('---------------------------END OF LOCAL HOST DEBUGGING--------------------------');
    }
}

// Set an interval to fetch air quality data every minute
setInterval(fetchAirQualityData, 60000 );
// setInterval(, 60000);
fetchAirQualityData();
// Start the server
app.listen(port, (err) => {
    if (err) {
        console.error('Error starting the server:', err);
        process.exit(1);
    }
    console.log(`Server running at http://localhost:${port}`);
});
