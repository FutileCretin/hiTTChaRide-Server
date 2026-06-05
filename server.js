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
let pendingVehicles = [];        // Stage 1: 4-minute initial pending
let confirmationVehicles = [];   // Stage 2: 2-minute confirmation pending  
let outOfServiceVehicles = [];
let lastBulkUpdateTime = 0;       // Timestamp for incremental bulk updates

// Sleep mode configuration (Toronto Eastern Time)
function isSystemSleeping() {
  const now = new Date();
  const torontoTime = new Date(now.toLocaleString("en-US", {timeZone: "America/Toronto"}));
  const hour = torontoTime.getHours();
  const minute = torontoTime.getMinutes();
  
  // Sleep from 10:30 PM to 3:08 AM (22:30 to 03:08)
  const sleepStart = 22.5; // 10:30 PM
  const sleepEnd = 3.13;   // 3:08 AM
  const currentTime = hour + (minute / 60);
  
  // Handle overnight sleep period
  if (sleepStart > sleepEnd) {
    return currentTime >= sleepStart || currentTime < sleepEnd;
  } else {
    return currentTime >= sleepStart && currentTime < sleepEnd;
  }
}

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

// Main processing logic - 2-stage pending system (4min + 2min)
async function processBusDetection() {
  const busVehicles = await fetchTTCVehicles();
  if (busVehicles.length === 0) return;
  
  const now = new Date();
  const previousVehicleIds = vehicles.map(v => v.id);
  const currentVehicleIds = busVehicles.map(v => v.id);
  
  // STAGE 1: Find vehicles that disappeared - add to 4-minute pending
  const disappearedIds = previousVehicleIds.filter(id => !currentVehicleIds.includes(id));
  const newPending = disappearedIds
    .map(id => vehicles.find(v => v.id === id))
    .filter(Boolean)
    .map(vehicle => new PendingVehicle(vehicle, now));
  
  // Update Stage 1 pending list (remove buses that reappeared)
  pendingVehicles = pendingVehicles
    .filter(v => !currentVehicleIds.includes(v.id))
    .concat(newPending.filter(v => !pendingVehicles.some(p => p.id === v.id)));
  
  if (newPending.length > 0) {
    console.log(`🟡 STAGE 1: Added ${newPending.length} buses to 4-min pending:`, newPending.map(v => v.id));
  }
  
  // STAGE 2: Move buses from 4-min pending to 2-min confirmation after 4 minutes
  const fourMinutesAgo = new Date(now.getTime() - 4 * 60 * 1000);
  const toConfirmation = pendingVehicles.filter(v => 
    v.disappearedAt <= fourMinutesAgo && 
    !currentVehicleIds.includes(v.id) &&
    v.speedKmHr > 5  // Only buses that were moving
  );
  
  // Move to confirmation list
  const newConfirmation = toConfirmation.filter(v => 
    !confirmationVehicles.some(c => c.id === v.id)
  );
  
  confirmationVehicles = confirmationVehicles
    .filter(v => !currentVehicleIds.includes(v.id)) // Remove buses that reappeared
    .concat(newConfirmation);
  
  // Remove promoted buses from Stage 1 pending
  const promotedIds = toConfirmation.map(v => v.id);
  pendingVehicles = pendingVehicles.filter(v => !promotedIds.includes(v.id));
  
  if (newConfirmation.length > 0) {
    console.log(`🟠 STAGE 2: Moved ${newConfirmation.length} buses to 2-min confirmation:`, newConfirmation.map(v => v.id));
  }
  
  // STAGE 3: Promote buses from confirmation to map after 2 more minutes
  const sixMinutesAgo = new Date(now.getTime() - 6 * 60 * 1000); // 4min + 2min = 6min total
  const vehiclesToPromote = confirmationVehicles.filter(v => 
    v.disappearedAt <= sixMinutesAgo && 
    !currentVehicleIds.includes(v.id)
  );
  
  // Remove promoted buses from confirmation list
  const finalPromotedIds = vehiclesToPromote.map(v => v.id);
  confirmationVehicles = confirmationVehicles.filter(v => !finalPromotedIds.includes(v.id));
  
  // CLEANUP: Remove any buses that are back in service
  outOfServiceVehicles = outOfServiceVehicles.filter(v => {
    const isInAPI = currentVehicleIds.includes(v.id);
    const expired = v.broadcastUntil <= now;
    
    const shouldRemove = isInAPI || expired;
    
    if (shouldRemove) {
      console.log(`🔥 CLEANUP: Removing ${v.id} - InAPI=${isInAPI}, Expired=${expired}`);
    }
    
    return !shouldRemove;
  });
  
  // Convert confirmed vehicles to map format
  const promoted = vehiclesToPromote.map(vehicle => 
    new OutOfServiceVehicle(
      vehicle,
      vehicle.disappearedAt,
      new Date(now.getTime() + 20 * 60 * 1000), // 20 minutes from now
      vehicle.lat,
      vehicle.lon
    )
  );
  
  // Add to map (only unique buses not already displayed)
  const existingIds = outOfServiceVehicles.map(v => v.id);
  const uniquePromoted = promoted.filter(v => 
    !existingIds.includes(v.id) && !currentVehicleIds.includes(v.id)
  );
  
  outOfServiceVehicles = outOfServiceVehicles.concat(uniquePromoted);
  
  if (uniquePromoted.length > 0) {
    console.log(`🟢 STAGE 3: Promoted ${uniquePromoted.length} buses to MAP:`, uniquePromoted.map(v => v.id));
  }
  
  console.log(`📊 SUMMARY: Active=${busVehicles.length}, Pending-4min=${pendingVehicles.length}, Confirmation-2min=${confirmationVehicles.length}, Broadcasting=${outOfServiceVehicles.length}`);
  
  // Update vehicles for next cycle
  vehicles = busVehicles;
}

// API endpoint for your app
app.get('/current-buses', (req, res) => {
  console.log('📱 App requested current buses');
  
  // Check if system is sleeping
  if (isSystemSleeping()) {
    console.log('😴 System sleeping - returning sleep status');
    res.json({
      sleeping: true,
      message: "4000 sorry...not in service till 3:08am",
      resumeTime: "3:08am",
      timestamp: new Date().toISOString()
    });
    return;
  }
  
  res.json({
    sleeping: false,
    timestamp: new Date().toISOString(),
    count: outOfServiceVehicles.length,
    buses: outOfServiceVehicles
  });
});

// Health check
app.get('/health', (req, res) => {
  const sleeping = isSystemSleeping();
  res.json({
    status: 'healthy',
    sleeping: sleeping,
    sleepMessage: sleeping ? "System sleeping until 3:08am" : "System active",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    summary: {
      active: vehicles.length,
      pending4min: pendingVehicles.length,
      confirmation2min: confirmationVehicles.length,
      broadcasting: outOfServiceVehicles.length
    }
  });
});

// TransSee-style GPS tracking with 30-second frequency and data validation
async function updateBulkGPS() {
  if (isSystemSleeping() || outOfServiceVehicles.length === 0) {
    return;
  }
  
  console.log(`🚄 [TRANSEE] GPS tracking for ${outOfServiceVehicles.length} buses using TransSee methodology (30s intervals)`);
  
  try {
    // Use timestamp for incremental updates (TransSee method)
    const apiUrl = `https://retro.umoiq.com/service/publicXMLFeed?command=vehicleLocations&a=ttc&t=${lastBulkUpdateTime}`;
    console.log(`🚄 [BULK] Fetching updates since timestamp: ${lastBulkUpdateTime}`);
    
    const response = await fetch(apiUrl);
    const xmlText = await response.text();
    
    // Extract new timestamp for next request
    const lastTimeMatch = xmlText.match(/<lastTime time="([^"]*)"\/>/);
    if (lastTimeMatch) {
      lastBulkUpdateTime = parseInt(lastTimeMatch[1]);
      console.log(`🚄 [BULK] Updated timestamp to: ${lastBulkUpdateTime}`);
    }
    
    // Parse all vehicles from bulk response
    const vehicleMatches = xmlText.match(/<vehicle[^>]*>/g) || [];
    const bulkVehicleMap = new Map();
    
    vehicleMatches.forEach(match => {
      const id = match.match(/id="([^"]*)"/)?.[ 1];
      const lat = match.match(/lat="([^"]*)"/)?.[ 1];
      const lon = match.match(/lon="([^"]*)"/)?.[ 1];
      const heading = match.match(/heading="([^"]*)"/)?.[ 1];
      const speedKmHr = match.match(/speedKmHr="([^"]*)"/)?.[ 1];
      
      if (id && lat && lon) {
        bulkVehicleMap.set(id, {
          lat: parseFloat(lat),
          lon: parseFloat(lon),
          heading: parseInt(heading || '0'),
          speedKmHr: parseInt(speedKmHr || '0')
        });
      }
    });
    
    console.log(`🚄 [BULK] Received ${bulkVehicleMap.size} vehicle updates from API`);
    
    // Update buses with API data OR dead reckoning
    let apiUpdatedCount = 0;
    let deadReckonedCount = 0;
    const now = new Date();
    
    outOfServiceVehicles = outOfServiceVehicles.map(bus => {
      if (bulkVehicleMap.has(bus.id)) {
        // Bus found in API - use fresh coordinates
        const update = bulkVehicleMap.get(bus.id);
        apiUpdatedCount++;
        
        console.log(`🎯 [API] Updated bus ${bus.id}: ${update.lat}, ${update.lon} (heading: ${update.heading}°, speed: ${update.speedKmHr}km/h)`);
        
        return {
          ...bus,
          lat: update.lat,
          lon: update.lon,
          heading: update.heading,
          speedKmHr: update.speedKmHr,
          lastUpdateTime: now,
          lastKnownLat: update.lat,
          lastKnownLon: update.lon
        };
      } else {
        // Bus not in API - use dead reckoning from last known position
        const elapsedMs = now.getTime() - bus.lastUpdateTime.getTime();
        const maxDriftMs = 60000; // Cap drift at 1 minute to prevent buses from going too far
        
        if (elapsedMs < maxDriftMs && bus.speedKmHr > 5) {
          // Dead reckon forward using last known heading and speed
          const elapsedHours = elapsedMs / 3_600_000;
          const distKm = bus.speedKmHr * elapsedHours;
          const R = 6371; // Earth radius in km
          const hRad = (bus.heading * Math.PI) / 180;
          
          const dLat = (distKm * Math.cos(hRad) / R) * (180 / Math.PI);
          const dLon = (distKm * Math.sin(hRad) / R) * (180 / Math.PI) / Math.cos(bus.lat * Math.PI / 180);
          
          const newLat = bus.lat + dLat;
          const newLon = bus.lon + dLon;
          deadReckonedCount++;
          
          console.log(`🧭 [DEAD-RECKON] Bus ${bus.id}: ${newLat.toFixed(6)}, ${newLon.toFixed(6)} (moving from ${bus.lat.toFixed(6)}, ${bus.lon.toFixed(6)})`);
          
          return {
            ...bus,
            lat: newLat,
            lon: newLon,
            lastUpdateTime: now
          };
        } else if (elapsedMs >= maxDriftMs) {
          // Try individual API lookup for fresh coordinates (sliding fix)
          console.log(`🔄 [REFRESH] Bus ${bus.id}: attempting coordinate refresh after ${Math.round(elapsedMs/1000)}s drift`);
          
          // Reset last update time to allow fresh individual lookup on next cycle
          return {
            ...bus,
            lastUpdateTime: new Date(now.getTime() - maxDriftMs + 30000) // Trigger refresh in 30 seconds
          };
        } else {
          // Keep bus stationary if slow
          console.log(`🔒 [STATIONARY] Bus ${bus.id}: keeping at ${bus.lat}, ${bus.lon} (speed: ${bus.speedKmHr}km/h)`);
          return bus;
        }
      }
    });
    
    console.log(`✅ [BULK] Tracking complete - API: ${apiUpdatedCount}, Dead-Reckoned: ${deadReckonedCount}, Total: ${outOfServiceVehicles.length} buses`);
    
  } catch (error) {
    console.error('❌ [BULK] GPS tracking error:', error);
  }
}

// Schedule tasks
console.log('🚀 Starting hiTTChaRide Cloud Service...');

// Main detection every 4 minutes (Stage 1 & 2 processing)
cron.schedule('*/4 * * * *', () => {
  if (!isSystemSleeping()) {
    console.log('🔄 Starting 4-minute detection cycle');
    processBusDetection();
  } else {
    console.log('😴 Skipping detection - system sleeping');
  }
});

// Server-side bulk GPS tracking every 10 seconds (TransSee method)
setInterval(() => {
  if (!isSystemSleeping()) {
    updateBulkGPS();
  }
}, 30000); // 30 seconds (TransSee frequency)

// Removed 2-minute cleanup - simplified to 5-minute only

// 5-minute FULL cleanup (safety check for map buses)
cron.schedule('*/5 * * * *', async () => {
  if (isSystemSleeping()) {
    console.log('😴 Skipping 5-min cleanup - system sleeping');
    return;
  }
  
  console.log('🔥 Running 5-minute FULL cleanup check...');
  const busVehicles = await fetchTTCVehicles();
  const currentVehicleIds = busVehicles.map(v => v.id);
  
  const before = outOfServiceVehicles.length;
  
  // AGGRESSIVE cleanup - remove ANY bus found in active API
  outOfServiceVehicles = outOfServiceVehicles.filter(v => {
    const isInAPI = currentVehicleIds.includes(v.id);
    const expired = v.broadcastUntil <= new Date();
    
    if (isInAPI || expired) {
      console.log(`🔥 FULL CLEANUP removed ${v.id} - InAPI=${isInAPI}, Expired=${expired}`);
      return false;
    }
    return true;
  });
  
  const cleaned = before - outOfServiceVehicles.length;
  if (cleaned > 0) {
    console.log(`🔥 FULL cleanup removed ${cleaned} buses - map now clean`);
  } else {
    console.log('🔥 FULL cleanup complete - no false positives found');
  }
});

// Start initial processing
if (!isSystemSleeping()) {
  console.log('🚀 Starting initial bus detection');
  processBusDetection();
} else {
  console.log('😴 System starting in sleep mode - no initial processing');
}

// Start server
app.listen(PORT, () => {
  console.log(`✅ hiTTChaRide Cloud Service running on port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(`📱 Bus data: http://localhost:${PORT}/current-buses`);
});

// Force redeploy - bulk tracking deployment - timestamp: 2026-06-05
