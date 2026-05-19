const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for your mobile app
app.use(cors());
app.use(express.json());

// In-memory storage (will move to proper database)
let vehicles = [];
let pendingVehicles = [];
let outOfServiceVehicles = [];

// Interface definitions (matching your app)
class Vehicle {
  constructor(id, routeTag, lat, lon, heading, speedKmHr) {
    this.id = id;
    this.routeTag = routeTag;
    this.lat = lat;
    this.lon = lon;
    this.heading = heading;
    this.speedKmHr = speedKmHr;
  }
}

class PendingVehicle extends Vehicle {
  constructor(vehicle, disappearedAt) {
    super(vehicle.id, vehicle.routeTag, vehicle.lat, vehicle.lon, vehicle.heading, vehicle.speedKmHr);
    this.disappearedAt = disappearedAt;
  }
}

class OutOfServiceVehicle extends Vehicle {
  constructor(vehicle, lastSeenAt, broadcastUntil, lastKnownLat, lastKnownLon) {
    super(vehicle.id, vehicle.routeTag, vehicle.lat, vehicle.lon, vehicle.heading, vehicle.speedKmHr);
    this.lastSeenAt = lastSeenAt;
    this.broadcastUntil = broadcastUntil;
    this.lastKnownLat = lastKnownLat;
    this.lastKnownLon = lastKnownLon;
    this.lastUpdateTime = new Date();
  }
}

// Fetch TTC vehicles (same logic as your app)
async function fetchTTCVehicles() {
  try {
    console.log('🔄 Fetching TTC data...');
    const response = await fetch('https://webservices.umoiq.com/service/publicXMLFeed?command=vehicleLocations&a=ttc');
    const xmlText = await response.text();
    
    // Parse XML and filter for buses only (exclude 5xx streetcars)
    const vehicleMatches = xmlText.match(/<vehicle[^>]*>/g) || [];
    const busVehicles = [];
    
    vehicleMatches.forEach((match, index) => {
      const id = match.match(/id="([^"]*)"/)?.[ 1];
      const routeTag = match.match(/routeTag="([^"]*)"/)?.[ 1];
      const lat = match.match(/lat="([^"]*)"/)?.[ 1];
      const lon = match.match(/lon="([^"]*)"/)?.[ 1];
      const heading = match.match(/heading="([^"]*)"/)?.[ 1];
      const speedKmHr = match.match(/speedKmHr="([^"]*)"/)?.[ 1];
      
      // Only include buses (exclude streetcars that start with 5)
      if (id && routeTag && lat && lon && !routeTag.startsWith('5')) {
        busVehicles.push(new Vehicle(
          id,
          routeTag,
          parseFloat(lat),
          parseFloat(lon),
          parseInt(heading || '0'),
          parseInt(speedKmHr || '0')
        ));
      }
    });
    
    console.log(`📊 Found ${busVehicles.length} active buses`);
    return busVehicles;
  } catch (error) {
    console.error('❌ Error fetching TTC data:', error);
    return [];
  }
}

// Main processing logic (your 1min + 4min system)
async function processBusDetection() {
  const busVehicles = await fetchTTCVehicles();
  if (busVehicles.length === 0) return;
  
  const now = new Date();
  const previousVehicleIds = vehicles.map(v => v.id);
  const currentVehicleIds = busVehicles.map(v => v.id);
  
  // Find vehicles that disappeared (went out of service)
  const disappearedIds = previousVehicleIds.filter(id => !currentVehicleIds.includes(id));
  
  // Add newly disappeared buses to pending list (1-minute buffer)
  const newPending = disappearedIds
    .map(id => vehicles.find(v => v.id === id))
    .filter(Boolean)
    .map(vehicle => new PendingVehicle(vehicle, now));
  
  // Update pending vehicles list
  pendingVehicles = pendingVehicles
    .filter(v => !currentVehicleIds.includes(v.id)) // Remove buses that reappeared
    .concat(newPending.filter(v => !pendingVehicles.some(p => p.id === v.id))); // Add unique new pending
  
  if (newPending.length > 0) {
    console.log(`➕ Added ${newPending.length} buses to pending:`, newPending.map(v => v.id));
  }
  
  // Promote buses that have been missing for 4+ minutes AND were moving
  const fourMinutesAgo = new Date(now.getTime() - 4 * 60 * 1000);
  const vehiclesToPromote = pendingVehicles.filter(v => 
    v.disappearedAt <= fourMinutesAgo && 
    !currentVehicleIds.includes(v.id) &&
    v.speedKmHr > 5  // Only promote buses that were moving (>5 km/h)
  );
  
  // FORCED removal - completely rebuild list without false positives
  outOfServiceVehicles = outOfServiceVehicles.filter(v => {
    const isInAPI = currentVehicleIds.includes(v.id);
    const expired = v.broadcastUntil <= now;
    
    const shouldRemove = isInAPI || expired;
    
    if (shouldRemove) {
      console.log(`🔥 REMOVING ${v.id} - InAPI=${isInAPI}, Expired=${expired}`);
    }
    
    return !shouldRemove;
  });
  
  // Convert promoted vehicles to out-of-service format
  const promoted = vehiclesToPromote.map(vehicle => 
    new OutOfServiceVehicle(
      vehicle,
      vehicle.disappearedAt,
      new Date(now.getTime() + 25 * 60 * 1000), // 25 minutes from now
      vehicle.lat,
      vehicle.lon
    )
  );
  
  // Add promoted vehicles (only if not already in list AND not in API)
  const existingIds = outOfServiceVehicles.map(v => v.id);
  const uniquePromoted = promoted.filter(v => 
    !existingIds.includes(v.id) && !currentVehicleIds.includes(v.id)
  );
  
  outOfServiceVehicles = outOfServiceVehicles.concat(uniquePromoted);
  
  if (uniquePromoted.length > 0) {
    console.log(`🚌 Promoted ${uniquePromoted.length} buses to map:`, uniquePromoted.map(v => v.id));
  }
  
  console.log(`📊 SUMMARY: Active=${busVehicles.length}, Pending=${pendingVehicles.length}, Broadcasting=${outOfServiceVehicles.length}`);
  
  // Update vehicles for next cycle
  vehicles = busVehicles;
}

// API endpoint for your app
app.get('/current-buses', (req, res) => {
  console.log('📱 App requested current buses');
  res.json({
    timestamp: new Date().toISOString(),
    count: outOfServiceVehicles.length,
    buses: outOfServiceVehicles
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    summary: {
      active: vehicles.length,
      pending: pendingVehicles.length,
      broadcasting: outOfServiceVehicles.length
    }
  });
});

// Schedule tasks
console.log('🚀 Starting hiTTChaRide Cloud Service...');

// Main detection every 30 seconds
cron.schedule('*/30 * * * * *', () => {
  processBusDetection();
});

// 2-minute cleanup (extra validation)
cron.schedule('*/2 * * * *', async () => {
  console.log('🧹 Running 2-minute cleanup check...');
  const busVehicles = await fetchTTCVehicles();
  const currentVehicleIds = busVehicles.map(v => v.id);
  
  const before = outOfServiceVehicles.length;
  outOfServiceVehicles = outOfServiceVehicles.filter(v => {
    const isInAPI = currentVehicleIds.includes(v.id);
    if (isInAPI) {
      console.log(`🧹 Cleanup removed ${v.id} - back in service`);
    }
    return !isInAPI;
  });
  
  const cleaned = before - outOfServiceVehicles.length;
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} buses`);
  }
});

// Start initial processing
processBusDetection();

// Start server
app.listen(PORT, () => {
  console.log(`✅ hiTTChaRide Cloud Service running on port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(`📱 Bus data: http://localhost:${PORT}/current-buses`);
});