/*
============================================================
             MINEGUARD / FOGNET
        SINGLE ESP32 COMPLETE SYSTEM
============================================================

ONE ESP32 handles:

1. L298N + 2 DC motors
2. GPS / GNSS
3. MPU-6500
4. Buzzer
5. Phone/Laptop motor control
6. FOGNET HTTP telemetry

============================================================
PIN CONNECTIONS
============================================================

L298N:

ENA -> GPIO25
IN1 -> GPIO26
IN2 -> GPIO27

ENB -> GPIO13
IN3 -> GPIO14
IN4 -> GPIO12

Right motor -> OUT1 + OUT2
Left motor  -> OUT3 + OUT4

GPS:

GPS TX -> GPIO16
GPS RX -> GPIO17

MPU-6500:

SDA -> GPIO21
SCL -> GPIO22
Address = 0x68
WHO_AM_I = 0x70

Buzzer:

GPIO23

============================================================
IMPORTANT
============================================================

GPS values are NEVER fabricated.

If GPS has no fix:
latitude  = null
longitude = null
fixType   = NO_FIX

MPU values are read directly from the sensor.

No encoder is currently connected, therefore
encoderDistance is sent as null.

============================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Wire.h>
#include <TinyGPSPlus.h>

// ============================================================
// WIFI
// ============================================================

const char* WIFI_SSID = "YOUR_WIFI_NAME";

const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// ============================================================
// FOGNET API
// ============================================================

const char* ENDPOINT =
  "https://mine-guard-blush.vercel.app/api/public/vehicle/telemetry";

// Leave empty if your backend does not require a key.
const char* DEVICE_KEY = "";

const char* VEHICLE_ID = "V01";

// ============================================================
// WEB SERVER
// ============================================================

WebServer server(80);

// ============================================================
// L298N MOTOR PINS
// ============================================================

// RIGHT MOTOR
#define ENA 25
#define IN1 26
#define IN2 27

// LEFT MOTOR
#define ENB 13
#define IN3 14
#define IN4 12

// ============================================================
// GPS
// ============================================================

HardwareSerial GPS(2);

#define GPS_RX 16
#define GPS_TX 17

#define GPS_BAUD 9600

TinyGPSPlus gps;

// ============================================================
// MPU-6500
// ============================================================

#define MPU_ADDR 0x68

#define SDA_PIN 21
#define SCL_PIN 22

#define WHO_AM_I_REG  0x75
#define PWR_MGMT_1    0x6B
#define SMPLRT_DIV    0x19
#define CONFIG_REG    0x1A
#define GYRO_CONFIG   0x1B
#define ACCEL_CONFIG  0x1C
#define ACCEL_CONFIG2 0x1D

#define ACCEL_XOUT_H  0x3B
#define GYRO_XOUT_H   0x43

// ============================================================
// BUZZER
// ============================================================

#define BUZZER_PIN 23

#define TILT_LIMIT 25.0

// ============================================================
// MOTOR
// ============================================================

int motorSpeed = 180;

String currentDirection = "STOP";

// ============================================================
// MPU DATA
// ============================================================

float ax = 0;
float ay = 0;
float az = 0;

float gx = 0;
float gy = 0;
float gz = 0;

float pitch = 0;
float roll = 0;

bool imuOK = false;

// ============================================================
// GPS DATA
// ============================================================

bool gpsFix = false;

double latitude = 0;
double longitude = 0;
double altitude = 0;

double gpsSpeedKmh = 0;
double gpsHeading = 0;

int satellites = 0;

// ============================================================
// TIMERS
// ============================================================

unsigned long lastTelemetry = 0;
unsigned long lastSensorPrint = 0;

const unsigned long TELEMETRY_INTERVAL = 500;

// ============================================================
// MOTOR STOP
// ============================================================

void stopMotors() {

  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);

  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);

  analogWrite(ENA, 0);
  analogWrite(ENB, 0);

  currentDirection = "STOP";
}

// ============================================================
// FORWARD
// ============================================================

void moveForward() {

  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);

  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);

  analogWrite(ENA, motorSpeed);
  analogWrite(ENB, motorSpeed);

  currentDirection = "FORWARD";
}

// ============================================================
// BACKWARD
// ============================================================

void moveBackward() {

  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);

  digitalWrite(IN3, LOW);
  digitalWrite(IN4, HIGH);

  analogWrite(ENA, motorSpeed);
  analogWrite(ENB, motorSpeed);

  currentDirection = "BACKWARD";
}

// ============================================================
// LEFT
// ============================================================

void turnLeft() {

  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);

  digitalWrite(IN3, LOW);
  digitalWrite(IN4, HIGH);

  analogWrite(ENA, motorSpeed);
  analogWrite(ENB, motorSpeed);

  currentDirection = "LEFT";
}

// ============================================================
// RIGHT
// ============================================================

void turnRight() {

  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);

  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);

  analogWrite(ENA, motorSpeed);
  analogWrite(ENB, motorSpeed);

  currentDirection = "RIGHT";
}

// ============================================================
// MPU WRITE
// ============================================================

void mpuWrite(byte reg, byte value) {

  Wire.beginTransmission(MPU_ADDR);

  Wire.write(reg);
  Wire.write(value);

  Wire.endTransmission();
}

// ============================================================
// MPU READ BYTE
// ============================================================

byte mpuReadByte(byte reg) {

  Wire.beginTransmission(MPU_ADDR);

  Wire.write(reg);

  if (Wire.endTransmission(false) != 0) {
    return 0;
  }

  Wire.requestFrom(MPU_ADDR, 1);

  if (Wire.available()) {
    return Wire.read();
  }

  return 0;
}

// ============================================================
// MPU READ 16-BIT
// ============================================================

int16_t mpuRead16(byte reg) {

  Wire.beginTransmission(MPU_ADDR);

  Wire.write(reg);

  if (Wire.endTransmission(false) != 0) {
    return 0;
  }

  Wire.requestFrom(MPU_ADDR, 2);

  if (Wire.available() < 2) {
    return 0;
  }

  byte highByte = Wire.read();
  byte lowByte = Wire.read();

  return ((int16_t)highByte << 8) | lowByte;
}

// ============================================================
// INITIALIZE MPU
// ============================================================

bool initializeMPU() {

  byte whoAmI =
    mpuReadByte(WHO_AM_I_REG);

  Serial.print("MPU WHO_AM_I = 0x");
  Serial.println(whoAmI, HEX);

  if (whoAmI != 0x70) {

    Serial.println("MPU-6500 NOT detected!");

    return false;
  }

  Serial.println("MPU-6500 detected!");

  // Wake MPU
  mpuWrite(
    PWR_MGMT_1,
    0x00
  );

  delay(100);

  // Sample rate
  mpuWrite(
    SMPLRT_DIV,
    0x07
  );

  // DLPF
  mpuWrite(
    CONFIG_REG,
    0x03
  );

  // Gyro ±250 deg/s
  mpuWrite(
    GYRO_CONFIG,
    0x00
  );

  // Accelerometer ±2g
  mpuWrite(
    ACCEL_CONFIG,
    0x00
  );

  // Accelerometer filter
  mpuWrite(
    ACCEL_CONFIG2,
    0x03
  );

  delay(100);

  return true;
}

// ============================================================
// READ MPU
// ============================================================

void readMPU() {

  if (!imuOK) {
    return;
  }

  int16_t rawAx =
    mpuRead16(ACCEL_XOUT_H);

  int16_t rawAy =
    mpuRead16(ACCEL_XOUT_H + 2);

  int16_t rawAz =
    mpuRead16(ACCEL_XOUT_H + 4);

  int16_t rawGx =
    mpuRead16(GYRO_XOUT_H);

  int16_t rawGy =
    mpuRead16(GYRO_XOUT_H + 2);

  int16_t rawGz =
    mpuRead16(GYRO_XOUT_H + 4);

  // ±2g
  ax = rawAx / 16384.0;

  ay = rawAy / 16384.0;

  az = rawAz / 16384.0;

  // ±250 deg/s
  gx = rawGx / 131.0;

  gy = rawGy / 131.0;

  gz = rawGz / 131.0;

  // Pitch
  pitch =
    atan2(
      ay,
      sqrt(
        ax * ax +
        az * az
      )
    )
    * 180.0 / PI;

  // Roll
  roll =
    atan2(
      -ax,
      az
    )
    * 180.0 / PI;
}

// ============================================================
// BUZZER
// ============================================================

void updateBuzzer() {

  if (!imuOK) {

    digitalWrite(
      BUZZER_PIN,
      LOW
    );

    return;
  }

  bool warning =
    abs(pitch) > TILT_LIMIT ||
    abs(roll) > TILT_LIMIT;

  if (warning) {

    digitalWrite(
      BUZZER_PIN,
      HIGH
    );

  } else {

    digitalWrite(
      BUZZER_PIN,
      LOW
    );
  }
}

// ============================================================
// READ GPS
// ============================================================

void readGPS() {

  while (GPS.available()) {

    char c =
      GPS.read();

    gps.encode(c);
  }

  gpsFix =
    gps.location.isValid();

  if (gpsFix) {

    latitude =
      gps.location.lat();

    longitude =
      gps.location.lng();

    if (gps.altitude.isValid()) {

      altitude =
        gps.altitude.meters();
    }

    if (gps.speed.isValid()) {

      gpsSpeedKmh =
        gps.speed.kmph();
    }

    if (gps.course.isValid()) {

      gpsHeading =
        gps.course.deg();
    }
  }

  if (gps.satellites.isValid()) {

    satellites =
      gps.satellites.value();

  } else {

    satellites = 0;
  }
}

// ============================================================
// FIX TYPE
// ============================================================

const char* getFixType() {

  if (!gpsFix) {

    return "NO_FIX";
  }

  return "SINGLE";
}

// ============================================================
// WIFI CONNECT
// ============================================================

void connectWiFi() {

  if (
    WiFi.status() ==
    WL_CONNECTED
  ) {
    return;
  }

  Serial.println();
  Serial.println(
    "Connecting Wi-Fi..."
  );

  WiFi.mode(WIFI_STA);

  WiFi.begin(
    WIFI_SSID,
    WIFI_PASS
  );

  unsigned long start =
    millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - start < 15000
  ) {

    delay(500);

    Serial.print(".");
  }

  Serial.println();

  if (
    WiFi.status() ==
    WL_CONNECTED
  ) {

    Serial.println(
      "Wi-Fi connected!"
    );

    Serial.print(
      "ESP32 IP: "
    );

    Serial.println(
      WiFi.localIP()
    );

  } else {

    Serial.println(
      "Wi-Fi connection failed."
    );
  }
}

// ============================================================
// JSON TELEMETRY
// ============================================================

String createTelemetryJSON() {

  String body;

  body.reserve(1000);

  body += "{";

  // Vehicle
  body += "\"vehicleId\":\"";
  body += VEHICLE_ID;
  body += "\",";

  // ----------------------------------------------------------
  // GPS
  // ----------------------------------------------------------

  if (gpsFix) {

    body += "\"latitude\":";
    body += String(
      latitude,
      7
    );
    body += ",";

    body += "\"longitude\":";
    body += String(
      longitude,
      7
    );
    body += ",";

    body += "\"altitude\":";
    body += String(
      altitude,
      2
    );
    body += ",";

    body += "\"speed\":";
    body += String(
      gpsSpeedKmh,
      2
    );
    body += ",";

    body += "\"heading\":";
    body += String(
      gpsHeading,
      1
    );
    body += ",";

  } else {

    body += "\"latitude\":null,";
    body += "\"longitude\":null,";
    body += "\"altitude\":null,";
    body += "\"speed\":null,";
    body += "\"heading\":null,";
  }

  // GPS accuracy unavailable from TinyGPSPlus
  body += "\"gpsAccuracy\":null,";

  // Fix
  body += "\"fixType\":\"";
  body += getFixType();
  body += "\",";

  // Satellites
  body += "\"satellites\":";
  body += String(
    satellites
  );
  body += ",";

  // No encoder currently connected
  body += "\"encoderDistance\":null,";

  // Connection
  body += "\"connectionStatus\":\"ONLINE\",";

  // ----------------------------------------------------------
  // IMU
  // ----------------------------------------------------------

  body += "\"imu\":{";

  body += "\"ax\":";
  body += String(
    ax,
    3
  );
  body += ",";

  body += "\"ay\":";
  body += String(
    ay,
    3
  );
  body += ",";

  body += "\"az\":";
  body += String(
    az,
    3
  );
  body += ",";

  body += "\"gx\":";
  body += String(
    gx,
    3
  );
  body += ",";

  body += "\"gy\":";
  body += String(
    gy,
    3
  );
  body += ",";

  body += "\"gz\":";
  body += String(
    gz,
    3
  );

  body += "},";

  // Pitch
  body += "\"pitch\":";
  body += String(
    pitch,
    2
  );
  body += ",";

  // Roll
  body += "\"roll\":";
  body += String(
    roll,
    2
  );
  body += ",";

  // Safety
  bool warning =
    abs(pitch) > TILT_LIMIT ||
    abs(roll) > TILT_LIMIT;

  body += "\"tiltWarning\":";

  body += warning
    ? "true"
    : "false";

  body += ",";

  // Motor status
  body += "\"direction\":\"";
  body += currentDirection;
  body += "\",";

  body += "\"motorSpeed\":";
  body += String(
    motorSpeed
  );

  body += "}";

  return body;
}

// ============================================================
// SEND TELEMETRY
// ============================================================

void sendTelemetry() {

  if (
    WiFi.status() !=
    WL_CONNECTED
  ) {

    return;
  }

  String body =
    createTelemetryJSON();

  WiFiClientSecure client;

  // Prototype HTTPS connection.
  client.setInsecure();

  HTTPClient http;

  if (
    !http.begin(
      client,
      ENDPOINT
    )
  ) {

    Serial.println(
      "HTTP begin failed!"
    );

    return;
  }

  http.setTimeout(5000);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  if (
    DEVICE_KEY != nullptr &&
    strlen(DEVICE_KEY) > 0
  ) {

    http.addHeader(
      "x-fognet-key",
      DEVICE_KEY
    );
  }

  int httpCode =
    http.POST(body);

  Serial.print(
    "Telemetry HTTP: "
  );

  Serial.println(
    httpCode
  );

  if (httpCode > 0) {

    String response =
      http.getString();

    Serial.print(
      "Server: "
    );

    Serial.println(
      response
    );

  } else {

    Serial.print(
      "HTTP Error: "
    );

    Serial.println(
      http.errorToString(
        httpCode
      )
    );
  }

  http.end();
}

// ============================================================
// MOTOR WEBPAGE
// ============================================================

String motorPage() {

  String page = R"rawliteral(
<!DOCTYPE html>
<html>
<head>

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>MineGuard Vehicle</title>

<style>

body{
  background:#111820;
  color:white;
  font-family:Arial,sans-serif;
  text-align:center;
  margin:0;
  padding:20px;
}

h1{
  color:#f5a623;
}

button{
  width:130px;
  height:70px;
  margin:8px;
  border:0;
  border-radius:10px;
  background:#222d38;
  color:white;
  font-size:18px;
  font-weight:bold;
}

button:active{
  background:#f5a623;
  color:#111;
}

.stop{
  background:#b3261e;
}

input{
  width:300px;
}

.status{
  margin:20px;
  padding:15px;
  background:#1c2630;
  border-radius:10px;
}

</style>

</head>

<body>

<h1>FOGNET / MINEGUARD</h1>

<div class="status">
Direction:
<b id="direction">STOP</b>
</div>

<div>

<button
onclick="cmd('forward')">
⬆ FORWARD
</button>

</div>

<div>

<button
onclick="cmd('left')">
⬅ LEFT
</button>

<button
class="stop"
onclick="cmd('stop')">
⛔ STOP
</button>

<button
onclick="cmd('right')">
RIGHT ➡
</button>

</div>

<div>

<button
onclick="cmd('backward')">
⬇ BACKWARD
</button>

</div>

<h3>Speed</h3>

<input
type="range"
min="0"
max="255"
value="180"
id="speed"
oninput="setSpeed(this.value)"
>

<p>
Speed PWM:
<span id="speedValue">180</span>
</p>

<script>

function cmd(command){

 fetch("/" + command)
 .then(r => r.text())
 .then(data => {

   document.getElementById(
     "direction"
   ).innerText = data;

 });

}

function setSpeed(value){

 document.getElementById(
   "speedValue"
 ).innerText = value;

 fetch(
   "/speed?value=" + value
 );

}

</script>

</body>
</html>
)rawliteral";

  return page;
}

// ============================================================
// WEB SERVER ROUTES
// ============================================================

void setupWebServer() {

  // Main motor control
  server.on(
    "/",
    []() {

      server.send(
        200,
        "text/html",
        motorPage()
      );
    }
  );

  // Forward
  server.on(
    "/forward",
    []() {

      moveForward();

      server.send(
        200,
        "text/plain",
        "FORWARD"
      );
    }
  );

  // Backward
  server.on(
    "/backward",
    []() {

      moveBackward();

      server.send(
        200,
        "text/plain",
        "BACKWARD"
      );
    }
  );

  // Left
  server.on(
    "/left",
    []() {

      turnLeft();

      server.send(
        200,
        "text/plain",
        "LEFT"
      );
    }
  );

  // Right
  server.on(
    "/right",
    []() {

      turnRight();

      server.send(
        200,
        "text/plain",
        "RIGHT"
      );
    }
  );

  // Stop
  server.on(
    "/stop",
    []() {

      stopMotors();

      server.send(
        200,
        "text/plain",
        "STOP"
      );
    }
  );

  // Speed
  server.on(
    "/speed",
    []() {

      if (
        server.hasArg("value")
      ) {

        motorSpeed =
          server.arg(
            "value"
          ).toInt();

        motorSpeed =
          constrain(
            motorSpeed,
            0,
            255
          );
      }

      server.send(
        200,
        "text/plain",
        String(motorSpeed)
      );
    }
  );

  // Real sensor data
  server.on(
    "/telemetry",
    []() {

      server.send(
        200,
        "application/json",
        createTelemetryJSON()
      );
    }
  );

  server.begin();

  Serial.println(
    "Motor control server started!"
  );
}

// ============================================================
// SETUP
// ============================================================

void setup() {

  Serial.begin(115200);

  delay(1000);

  Serial.println();
  Serial.println(
    "========================================"
  );

  Serial.println(
    "   MINEGUARD SINGLE ESP32"
  );

  Serial.println(
    "   MOTOR + GPS + IMU + BUZZER"
  );

  Serial.println(
    "========================================"
  );

  // ----------------------------------------------------------
  // MOTOR
  // ----------------------------------------------------------

  pinMode(
    ENA,
    OUTPUT
  );

  pinMode(
    IN1,
    OUTPUT
  );

  pinMode(
    IN2,
    OUTPUT
  );

  pinMode(
    ENB,
    OUTPUT
  );

  pinMode(
    IN3,
    OUTPUT
  );

  pinMode(
    IN4,
    OUTPUT
  );

  stopMotors();

  // ----------------------------------------------------------
  // BUZZER
  // ----------------------------------------------------------

  pinMode(
    BUZZER_PIN,
    OUTPUT
  );

  digitalWrite(
    BUZZER_PIN,
    LOW
  );

  // ----------------------------------------------------------
  // I2C
  // ----------------------------------------------------------

  Wire.begin(
    SDA_PIN,
    SCL_PIN
  );

  delay(500);

  imuOK =
    initializeMPU();

  // ----------------------------------------------------------
  // GPS
  // ----------------------------------------------------------

  GPS.begin(
    GPS_BAUD,
    SERIAL_8N1,
    GPS_RX,
    GPS_TX
  );

  Serial.println(
    "GPS UART started."
  );

  // ----------------------------------------------------------
  // WIFI
  // ----------------------------------------------------------

  connectWiFi();

  // ----------------------------------------------------------
  // WEB SERVER
  // ----------------------------------------------------------

  setupWebServer();

  Serial.println();
  Serial.println(
    "SYSTEM READY"
  );

  if (
    WiFi.status() ==
    WL_CONNECTED
  ) {

    Serial.print(
      "Motor control:"
    );

    Serial.print(
      " http://"
    );

    Serial.println(
      WiFi.localIP()
    );

    Serial.print(
      "Telemetry:"
    );

    Serial.print(
      " http://"
    );

    Serial.print(
      WiFi.localIP()
    );

    Serial.println(
      "/telemetry"
    );
  }
}

// ============================================================
// LOOP
// ============================================================

void loop() {

  // ----------------------------------------------------------
  // GPS
  // ----------------------------------------------------------

  readGPS();

  // ----------------------------------------------------------
  // IMU
  // ----------------------------------------------------------

  readMPU();

  updateBuzzer();

  // ----------------------------------------------------------
  // WEB SERVER
  // ----------------------------------------------------------

  server.handleClient();

  // ----------------------------------------------------------
  // WIFI
  // ----------------------------------------------------------

  if (
    WiFi.status() !=
    WL_CONNECTED
  ) {

    connectWiFi();
  }

  // ----------------------------------------------------------
  // SEND FOGNET TELEMETRY
  // ----------------------------------------------------------

  if (
    millis() - lastTelemetry >=
    TELEMETRY_INTERVAL
  ) {

    lastTelemetry =
      millis();

    sendTelemetry();
  }

  // ----------------------------------------------------------
  // SERIAL DEBUG
  // ----------------------------------------------------------

  if (
    millis() - lastSensorPrint >=
    2000
  ) {

    lastSensorPrint =
      millis();

    Serial.println();
    Serial.println(
      "========== LIVE DATA =========="
    );

    Serial.print(
      "Direction: "
    );

    Serial.println(
      currentDirection
    );

    Serial.print(
      "Motor PWM: "
    );

    Serial.println(
      motorSpeed
    );

    // GPS
    Serial.println(
      "GPS:"
    );

    if (gpsFix) {

      Serial.print(
        "FIX YES | Lat: "
      );

      Serial.print(
        latitude,
        7
      );

      Serial.print(
        " | Lon: "
      );

      Serial.println(
        longitude,
        7
      );

      Serial.print(
        "Speed: "
      );

      Serial.print(
        gpsSpeedKmh,
        2
      );

      Serial.print(
        " km/h | Heading: "
      );

      Serial.println(
        gpsHeading,
        1
      );

    } else {

      Serial.println(
        "NO FIX"
      );
    }

    Serial.print(
      "Satellites: "
    );

    Serial.println(
      satellites
    );

    // IMU
    Serial.println(
      "IMU:"
    );

    Serial.print(
      "AX: "
    );

    Serial.print(
      ax,
      3
    );

    Serial.print(
      " AY: "
    );

    Serial.print(
      ay,
      3
    );

    Serial.print(
      " AZ: "
    );

    Serial.println(
      az,
      3
    );

    Serial.print(
      "GX: "
    );

    Serial.print(
      gx,
      3
    );

    Serial.print(
      " GY: "
    );

    Serial.print(
      gy,
      3
    );

    Serial.print(
      " GZ: "
    );

    Serial.println(
      gz,
      3
    );

    Serial.print(
      "Pitch: "
    );

    Serial.print(
      pitch,
      2
    );

    Serial.print(
      " Roll: "
    );

    Serial.println(
      roll,
      2
    );

    Serial.println(
      "==============================="
    );
  }

  delay(2);
}