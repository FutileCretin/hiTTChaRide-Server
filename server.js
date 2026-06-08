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
      
      // Only include buses (exclude streetcars that start with 5 and LRVs 4500-4699)
      const vehicleId = parseInt(id);
      const isLRV = vehicleId >= 4500 && vehicleId <= 4699;
      if (id && routeTag && lat && lon && !routeTag.startsWith('5') && !isLRV) {
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

// Web frontend - serve the hiTTChaRide web app
app.get('/', (req, res) => {
  const webHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>hiTTChaRide - Live Bus Tracking</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            height: 100vh;
            overflow: hidden;
        }

        #map {
            width: 100%;
            height: 100vh;
        }

        .privacy-link {
            position: absolute;
            bottom: 20px;
            right: 20px;
            background-color: rgba(0, 0, 0, 0.7);
            padding: 8px;
            border-radius: 4px;
            z-index: 1000;
        }

        .privacy-link a {
            color: white;
            font-size: 12px;
            text-decoration: underline;
        }

        .sleep-container {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: #2c3e50;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            padding: 40px;
            z-index: 2000;
        }

        .sleep-icon {
            width: 150px;
            height: 150px;
            margin-bottom: 40px;
            background-color: #34495e;
            border-radius: 75px;
            display: flex;
            justify-content: center;
            align-items: center;
            font-size: 60px;
        }

        .sleep-message {
            text-align: center;
        }

        .sleep-message-line {
            color: #ecf0f1;
            font-size: 18px;
            font-weight: 500;
            margin-bottom: 8px;
        }

        .loading {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: #333;
            font-size: 16px;
            z-index: 1000;
        }
    </style>
</head>
<body>
    <div id="loading" class="loading">Loading hiTTChaRide...</div>
    <div id="sleep-screen" class="sleep-container" style="display: none;">
        <div class="sleep-icon">😴</div>
        <div class="sleep-message">
            <div class="sleep-message-line">4000</div>
            <div class="sleep-message-line">Sorry... Not In Service</div>
            <div class="sleep-message-line">till 3:08am</div>
        </div>
    </div>
    <div id="map"></div>
    <div class="privacy-link">
        <a href="https://hittcharide.github.io/privacy/" target="_blank">Privacy</a>
    </div>

    <script>
        let map;
        let markers = [];
        
        // Toronto center coordinates
        const TORONTO_CENTER = { lat: 43.6532, lng: -79.3832 };

        function initMap() {
            map = new google.maps.Map(document.getElementById('map'), {
                zoom: 11,
                center: TORONTO_CENTER,
                styles: [
                    {
                        featureType: 'transit',
                        stylers: [{ visibility: 'simplified' }]
                    }
                ]
            });

            // Start fetching bus data
            fetchBusData();
            setInterval(fetchBusData, 30000); // Every 30 seconds like the app
        }

        async function fetchBusData() {
            try {
                console.log('📱 Fetching from cloud server...');
                const response = await fetch('/current-buses');
                const data = await response.json();
                
                document.getElementById('loading').style.display = 'none';
                
                // Check if system is sleeping
                if (data.sleeping) {
                    console.log('😴 Server is sleeping');
                    document.getElementById('sleep-screen').style.display = 'flex';
                    document.getElementById('map').style.display = 'none';
                    clearMarkers();
                    return;
                } else {
                    document.getElementById('sleep-screen').style.display = 'none';
                    document.getElementById('map').style.display = 'block';
                }
                
                console.log(\`☁️ Cloud data: \${data.count || 0} buses ready to display\`);
                
                // Clear existing markers
                clearMarkers();
                
                // Add new markers for each bus
                const buses = data.buses || [];
                buses.forEach(bus => {
                    addBusMarker(bus);
                });
                
                console.log(\`🌐 Web updated: \${buses.length} buses displayed\`);
                
            } catch (error) {
                console.error('Error fetching bus data:', error);
                document.getElementById('loading').textContent = 'Connection error - retrying...';
            }
        }

        function addBusMarker(bus) {
            const position = { lat: bus.lat, lng: bus.lon };
            
            // Calculate time left
            const now = new Date();
            const broadcastUntil = new Date(bus.broadcastUntil);
            const timeLeft = Math.max(0, broadcastUntil.getTime() - now.getTime());
            const minutesLeft = Math.ceil(timeLeft / (1000 * 60));
            
            // Direction text
            const getDirectionText = (heading) => {
                if (heading >= 315 || heading < 45) return 'N';
                if (heading >= 45 && heading < 135) return 'E';
                if (heading >= 135 && heading < 225) return 'S';
                return 'W';
            };

            // Create custom marker
            const marker = new google.maps.Marker({
                position: position,
                map: map,
                title: \`Bus \${bus.id}\`,
                icon: {
                    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(\`
                        <svg width="36" height="36" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="18" cy="18" r="16" fill="#4A90E2" stroke="white" stroke-width="2"/>
                            <text x="18" y="22" text-anchor="middle" fill="white" font-family="Arial" font-size="10" font-weight="bold">\${bus.id}</text>
                        </svg>
                    \`),
                    scaledSize: new google.maps.Size(36, 36),
                    anchor: new google.maps.Point(18, 18)
                }
            });

            // Add info window
            const infoWindow = new google.maps.InfoWindow({
                content: \`
                    <div style="padding: 8px;">
                        <strong>Bus \${bus.id}</strong><br>
                        Route: \${bus.routeTag}<br>
                        Direction: \${getDirectionText(bus.heading)}<br>
                        Speed: \${bus.speedKmHr} km/h<br>
                        Time left: \${minutesLeft} min
                    </div>
                \`
            });

            marker.addListener('click', () => {
                infoWindow.open(map, marker);
            });

            markers.push(marker);
        }

        function clearMarkers() {
            markers.forEach(marker => marker.setMap(null));
            markers = [];
        }
    </script>
    <script async defer
        src="https://maps.googleapis.com/maps/api/js?key=AIzaSyCugWNKu6G8qLCDZIb_J8DWTn7FzzX6Tcs&callback=initMap">
    </script>
</body>
</html>`;
  
  res.send(webHtml);
});

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

// Individual vehicle lookups for accurate out-of-service bus tracking
async function updateBulkGPS() {
  if (isSystemSleeping() || outOfServiceVehicles.length === 0) {
    return;
  }
  
  console.log(`🎯 [INDIVIDUAL] GPS lookup for ${outOfServiceVehicles.length} buses using enhanced methodology`);
  
  try {
    // Use TransSee's method: individual vehicle lookups with vehicleLocation (singular) API
    let updatedCount = 0;
    const now = new Date();
    
    // Update each bus individually using TransSee's method
    const updatedBuses = await Promise.all(
      outOfServiceVehicles.map(async (bus) => {
        try {
          // Individual vehicle API call: vehicleLocation (singular) with v= parameter
          const apiUrl = `https://retro.umoiq.com/service/publicXMLFeed?command=vehicleLocation&a=ttc&v=${bus.id}`;
          console.log(`🎯 [INDIVIDUAL] Fetching coordinates for bus ${bus.id}`);
          
          const response = await fetch(apiUrl);
          const xmlText = await response.text();
          
          // Parse individual vehicle response
          const vehicleMatch = xmlText.match(/<vehicle[^>]*>/)?.[0];
          if (vehicleMatch) {
            const lat = vehicleMatch.match(/lat="([^"]*)"/)?.[ 1];
            const lon = vehicleMatch.match(/lon="([^"]*)"/)?.[ 1];
            const heading = vehicleMatch.match(/heading="([^"]*)"/)?.[ 1];
            const speedKmHr = vehicleMatch.match(/speedKmHr="([^"]*)"/)?.[ 1];
            const secsSinceReport = vehicleMatch.match(/secsSinceReport="([^"]*)"/)?.[ 1];
            
            if (lat && lon) {
              const newLat = parseFloat(lat);
              const newLon = parseFloat(lon);
              const newHeading = parseInt(heading || '0');
              const newSpeed = parseInt(speedKmHr || '0');
              const ageSeconds = parseInt(secsSinceReport || '0');
              
              // Data validation: discard coordinates >180 seconds old
              if (ageSeconds <= 180) {
                updatedCount++;
                console.log(`✅ [FRESH] Bus ${bus.id}: ${newLat}, ${newLon} (heading: ${newHeading}°, speed: ${newSpeed}km/h, age: ${ageSeconds}s)`);
                
                return {
                  ...bus,
                  lat: newLat,
                  lon: newLon,
                  heading: newHeading,
                  speedKmHr: newSpeed,
                  lastUpdateTime: now
                };
              } else {
                console.log(`⏰ [STALE] Bus ${bus.id}: coordinates too old (${ageSeconds}s), keeping previous position`);
                return bus;
              }
            }
          }
          
          console.log(`❌ [NO-DATA] Bus ${bus.id}: no coordinates returned from individual API`);
          return bus;
          
        } catch (error) {
          console.error(`❌ [ERROR] Bus ${bus.id} individual lookup failed:`, error.message);
          return bus;
        }
      })
    );
    
    outOfServiceVehicles = updatedBuses;
    console.log(`✅ [INDIVIDUAL] Tracking complete - ${updatedCount}/${outOfServiceVehicles.length} buses updated with fresh coordinates`);
    
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
