import type { ExternalCatalogEntry } from './catalog.js';

/** Generated from tools/meshy/manifest.json; rejected assets are intentionally absent. */
export const GALLERY_CATALOG = [
  {
    "label": "Sedan",
    "class": "vehicle",
    "description": "Mid-size four-door passenger car. The default other-vehicle: use it for lead, following and oncoming traffic when nothing special is required.",
    "dims": {
      "l": 4.505459692884411,
      "w": 1.9785972303607289,
      "h": 1.3982944176846943
    },
    "tags": [
      "occlusion:medium",
      "mobile",
      "parkable",
      "roadway"
    ],
    "defaultParams": {
      "color": "#2f4f74"
    },
    "actorClass": "car",
    "id": "gallery.vehicle.sedan",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.sedan/model.glb",
      "contentHash": "36e7559e1a2dff6b1fd7f96cf053de0fa65063f6b4a92ebb92beb63baf681053"
    }
  },
  {
    "label": "Pickup truck",
    "class": "vehicle",
    "description": "Full-size crew-cab pickup with an open bed. Long and tall; a parked one at a kerb blocks the sightline into a driveway.",
    "dims": {
      "l": 5.278996896568855,
      "w": 2.276801671769729,
      "h": 1.9681823977403003
    },
    "tags": [
      "occlusion:medium",
      "mobile",
      "parkable",
      "roadway"
    ],
    "defaultParams": {
      "color": "#5a6068"
    },
    "actorClass": "truck",
    "compatibleActorClasses": [
      "car"
    ],
    "id": "gallery.vehicle.pickup",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.pickup/model.glb",
      "contentHash": "595a57f781eb82961bb1d47ceb7112bf7ca4a2be422a31d12fd3d25f877c9882"
    }
  },
  {
    "label": "Cargo van",
    "class": "vehicle",
    "description": "High-roof delivery van. A double-parked one is the canonical occluder for a pedestrian stepping out mid-block.",
    "dims": {
      "l": 5.341945658441608,
      "w": 2.092007017722506,
      "h": 2.2817323504536864
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "parkable",
      "roadway"
    ],
    "defaultParams": {
      "color": "#e8e9ea"
    },
    "actorClass": "van",
    "id": "gallery.vehicle.van",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.van/model.glb",
      "contentHash": "16b62326119c7578b261b8aecd5b5794842f2a338c2be93efdc24ebdb47e36db"
    }
  },
  {
    "label": "Box truck",
    "class": "vehicle",
    "description": "Two-axle straight truck with a 24 ft cargo body. Completely blocks the sightline across an adjacent lane.",
    "dims": {
      "l": 7.821772325044213,
      "w": 2.7429870884787126,
      "h": 2.985567374016136
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "roadway",
      "large-vehicle"
    ],
    "defaultParams": {
      "color": "#e8e9ea"
    },
    "actorClass": "truck",
    "id": "gallery.vehicle.box_truck",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.box_truck/model.glb",
      "contentHash": "772efdd4d8bc7dcfe3bc6f650bcff2537700d3bc47f51306eee926d5b7964eff"
    }
  },
  {
    "label": "Motorcycle",
    "class": "vehicle",
    "description": "Standard motorcycle, no rider. Narrow silhouette used for lane-filtering, late-detection and misclassification cases.",
    "dims": {
      "l": 1.9091350944197085,
      "w": 0.8018589724698255,
      "h": 1.2750092395027952
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "vru",
      "parkable",
      "roadway"
    ],
    "defaultParams": {
      "color": "#25282c"
    },
    "actorClass": "motorcycle",
    "id": "gallery.vehicle.motorcycle",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.motorcycle/model.glb",
      "contentHash": "0151657e787b49b4eb3d6308a195abd5ec57bdccc09dcd05f4254dbce33ef30c"
    }
  },
  {
    "label": "Cyclist",
    "class": "vehicle",
    "description": "Bicycle with a seated rider. The reference vulnerable road user for bike-lane, dooring and right-hook conflicts.",
    "dims": {
      "l": 1.6619106917943267,
      "w": 0.5501869234133805,
      "h": 1.647060686301821
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "vru",
      "roadway"
    ],
    "defaultParams": {
      "color": "#2f4f74"
    },
    "actorClass": "bicycle",
    "id": "gallery.vehicle.bicycle",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.bicycle/model.glb",
      "contentHash": "79e65b8ecf5a78614f64b576a8aa70eb8a53b4529d6632179279af96aa269082"
    }
  },
  {
    "label": "Toyota Camry",
    "class": "vehicle",
    "description": "Modern Toyota Camry family sedan for common commuter traffic, rideshare pickup and parked-car occlusion scenes.",
    "dims": {
      "l": 4.497517809381661,
      "w": 2.0403038492377297,
      "h": 1.4312074066469744
    },
    "tags": [
      "occlusion:medium",
      "mobile",
      "parkable",
      "roadway",
      "passenger"
    ],
    "defaultParams": {
      "color": "#c8cbd0"
    },
    "actorClass": "car",
    "id": "gallery.vehicle.toyota_camry",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.toyota_camry/model.glb",
      "contentHash": "6ad41f25202f1c144ae79cde298cad8fd0a4bb395478b3212c2b0477f1d86c81"
    }
  },
  {
    "label": "Ford Mustang",
    "class": "vehicle",
    "description": "Ford Mustang two-door performance coupe with a long hood for recognizable enthusiast and high-acceleration traffic scenes.",
    "dims": {
      "l": 4.634818748274775,
      "w": 2.0026510923433714,
      "h": 1.395153162701845
    },
    "tags": [
      "occlusion:medium",
      "mobile",
      "parkable",
      "roadway",
      "passenger"
    ],
    "defaultParams": {
      "color": "#1f5fa8"
    },
    "actorClass": "car",
    "id": "gallery.vehicle.ford_mustang",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.ford_mustang/model.glb",
      "contentHash": "9c82017a639cf54bdc1b08ec445af9358f26dcc9b9fba4e9a8bde4dddac8d7cd"
    }
  },
  {
    "label": "Chevrolet Corvette",
    "class": "vehicle",
    "description": "Chevrolet Corvette low sports car with a wide stance for performance-driving and difficult low-profile detection scenarios.",
    "dims": {
      "l": 4.39899030248351,
      "w": 2.1284947571678527,
      "h": 1.1818494731130915
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "parkable",
      "roadway",
      "passenger"
    ],
    "defaultParams": {
      "color": "#d62828"
    },
    "actorClass": "car",
    "id": "gallery.vehicle.chevrolet_corvette",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.chevrolet_corvette/model.glb",
      "contentHash": "ca3b161cf8e210e8e4cb911f8e7162e16ee4b76c5a95b1f8e824a07bb3f4c5c2"
    }
  },
  {
    "label": "Porsche 911",
    "class": "vehicle",
    "description": "Porsche 911 sports coupe with its compact rounded roofline for premium urban traffic and performance scenarios.",
    "dims": {
      "l": 4.311233412888079,
      "w": 1.8397000825397378,
      "h": 1.3742399597905324
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "parkable",
      "roadway",
      "passenger"
    ],
    "defaultParams": {
      "color": "#d9dde2"
    },
    "actorClass": "car",
    "id": "gallery.vehicle.porsche_911",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.porsche_911/model.glb",
      "contentHash": "2127b623ef890013cd2e3d9e33f4a2811c50ebbb0e88ddd6756d2f4308a7b72a"
    }
  },
  {
    "label": "Jeep Wrangler",
    "class": "vehicle",
    "description": "Four-door Jeep Wrangler with an upright cabin and exposed spare-wheel silhouette for urban and trail-access scenes.",
    "dims": {
      "l": 4.281040232688939,
      "w": 2.009398441623495,
      "h": 1.9777693054173588
    },
    "tags": [
      "occlusion:medium",
      "mobile",
      "parkable",
      "roadway",
      "passenger"
    ],
    "defaultParams": {
      "color": "#49633d"
    },
    "actorClass": "car",
    "id": "gallery.vehicle.jeep_wrangler",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.jeep_wrangler/model.glb",
      "contentHash": "6933fea7b0fd3b273b68d7ade4eca4ea873c2f2d1d15a3884b5e4f4c49ace870"
    }
  },
  {
    "label": "City taxi",
    "class": "vehicle",
    "description": "Marked city taxi with a roof sign for curb pickup, sudden stopping, passenger loading and dense downtown traffic.",
    "dims": {
      "l": 4.213821472206197,
      "w": 1.8505633895504223,
      "h": 1.850824765008341
    },
    "tags": [
      "occlusion:medium",
      "mobile",
      "parkable",
      "roadway",
      "passenger",
      "service"
    ],
    "defaultParams": {
      "color": "#f0c419"
    },
    "actorClass": "car",
    "id": "gallery.vehicle.taxi",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.taxi/model.glb",
      "contentHash": "68a476e8ba80b992f6dcb8fb37c7c580008ef1e0bd5a3990bdb77c27282cf603"
    }
  },
  {
    "label": "Police cruiser",
    "class": "vehicle",
    "description": "Marked police sedan with a roof light bar for traffic stops, pursuits, blocked lanes and emergency-priority scenarios.",
    "dims": {
      "l": 4.73175599010294,
      "w": 2.077802941129193,
      "h": 1.6152212652002773
    },
    "tags": [
      "occlusion:medium",
      "mobile",
      "parkable",
      "roadway",
      "emergency",
      "service"
    ],
    "defaultParams": {
      "color": "#1f2937"
    },
    "actorClass": "car",
    "id": "gallery.vehicle.police_cruiser",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.police_cruiser/model.glb",
      "contentHash": "ff2bce31251082563aac2147e58d8a9e47563d5f788f5815d38268dc227b11df"
    }
  },
  {
    "label": "Police SUV",
    "class": "vehicle",
    "description": "Marked police utility vehicle with emergency lighting for incident command, pursuits and roadside response scenes.",
    "dims": {
      "l": 4.855652066036567,
      "w": 2.0649398081489743,
      "h": 1.9365496780138094
    },
    "tags": [
      "occlusion:medium",
      "mobile",
      "parkable",
      "roadway",
      "emergency",
      "service"
    ],
    "defaultParams": {
      "color": "#e9ecef"
    },
    "actorClass": "car",
    "id": "gallery.vehicle.police_suv",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.police_suv/model.glb",
      "contentHash": "10cf59eb53c03cc92241b961873f5580a3259d82a402245f1dbda52d338b1bbd"
    }
  },
  {
    "label": "Fire engine",
    "class": "vehicle",
    "description": "Full-size structural fire engine with equipment body, ladder and emergency light bar for active incident scenes.",
    "dims": {
      "l": 8.783211103093272,
      "w": 2.9095006921562154,
      "h": 3.4294462517449773
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "roadway",
      "large-vehicle",
      "emergency",
      "service"
    ],
    "defaultParams": {
      "color": "#b91c1c"
    },
    "actorClass": "truck",
    "id": "gallery.vehicle.fire_engine",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.fire_engine/model.glb",
      "contentHash": "70f6fd82301329bb75bc235aef907494f4ea37cbd770f10488bdc820e5d5fcde"
    }
  },
  {
    "label": "Dump truck",
    "class": "vehicle",
    "description": "Three-axle dump truck with a raised-sided aggregate bed for construction traffic, work zones and blind-spot cases.",
    "dims": {
      "l": 7.534069748864464,
      "w": 3.0425479794436434,
      "h": 3.192482367996775
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "roadway",
      "large-vehicle",
      "commercial",
      "workzone"
    ],
    "defaultParams": {
      "color": "#e1a11a"
    },
    "actorClass": "truck",
    "id": "gallery.vehicle.dump_truck",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.dump_truck/model.glb",
      "contentHash": "5fdbe740da3535d2de713e4adb0c2f1101f08621fecf56a4b1797144a1e56ef3"
    }
  },
  {
    "label": "Garbage truck",
    "class": "vehicle",
    "description": "Municipal refuse collection truck with a tall compactor body for frequent curb stops and neighborhood occlusion scenarios.",
    "dims": {
      "l": 7.593332007362303,
      "w": 3.000143415952347,
      "h": 3.67626958534092
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "roadway",
      "large-vehicle",
      "commercial",
      "service"
    ],
    "defaultParams": {
      "color": "#2f855a"
    },
    "actorClass": "truck",
    "id": "gallery.vehicle.garbage_truck",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.garbage_truck/model.glb",
      "contentHash": "97b399f0a65558f41536fa0dcc1d4cd61c219d9687f8cf4a09aedf10ca1c629e"
    }
  },
  {
    "label": "Tow truck",
    "class": "vehicle",
    "description": "Medium-duty rollback tow truck for disabled-vehicle recovery, shoulder operations and partially blocked traffic lanes.",
    "dims": {
      "l": 7.3244172198213136,
      "w": 2.5451827627457,
      "h": 2.7629080464264586
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "roadway",
      "large-vehicle",
      "commercial",
      "service"
    ],
    "defaultParams": {
      "color": "#f59e0b"
    },
    "actorClass": "truck",
    "id": "gallery.vehicle.tow_truck",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.tow_truck/model.glb",
      "contentHash": "0337a68a406b627e1aedc121f873780442f0e527aac4dbd33274a9cb70769fdb"
    }
  },
  {
    "label": "Cement mixer",
    "class": "vehicle",
    "description": "Heavy concrete mixer truck with a rotating-drum silhouette for construction deliveries, turns and large blind spots.",
    "dims": {
      "l": 7.2783404873974495,
      "w": 2.9520626759403,
      "h": 3.9192104968732018
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "roadway",
      "large-vehicle",
      "commercial",
      "workzone"
    ],
    "defaultParams": {
      "color": "#e5e7eb"
    },
    "actorClass": "truck",
    "id": "gallery.vehicle.cement_mixer",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.cement_mixer/model.glb",
      "contentHash": "a276c0f9bb311e689669951cc6203e95745e871b746a44d4c90deeeb1e56403e"
    }
  },
  {
    "label": "Utility bucket truck",
    "class": "vehicle",
    "description": "Utility service truck with a folded aerial bucket boom for roadside maintenance, lane closures and worker-safety scenes.",
    "dims": {
      "l": 7.886920146461005,
      "w": 2.657886302159353,
      "h": 3.530426345093958
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "roadway",
      "large-vehicle",
      "service",
      "workzone"
    ],
    "defaultParams": {
      "color": "#f8fafc"
    },
    "actorClass": "truck",
    "id": "gallery.vehicle.utility_bucket_truck",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.utility_bucket_truck/model.glb",
      "contentHash": "a482bf41ccd01ae13526be5a239b1b00b88959ae32211924bc7a2d3ca1cc80a8"
    }
  },
  {
    "label": "Tanker truck",
    "class": "vehicle",
    "description": "Rigid tanker truck with a cylindrical liquid tank for hazardous-goods routing, turning and high-occlusion scenarios.",
    "dims": {
      "l": 8.784802083071117,
      "w": 3.029386334807445,
      "h": 3.738320435342545
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "roadway",
      "large-vehicle",
      "commercial"
    ],
    "defaultParams": {
      "color": "#d7dce1"
    },
    "actorClass": "truck",
    "id": "gallery.vehicle.tanker_truck",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.tanker_truck/model.glb",
      "contentHash": "0e24d7741df5662a578de1c9c285fbde496692a54e7506f6f27652aa76d4fb24"
    }
  },
  {
    "label": "Flatbed truck",
    "class": "vehicle",
    "description": "Medium-duty flatbed truck for oversized cargo, loading activity and variable roadside obstruction scenarios.",
    "dims": {
      "l": 6.8806289178663675,
      "w": 2.9505180635585635,
      "h": 2.6767494018305005
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "roadway",
      "large-vehicle",
      "commercial"
    ],
    "defaultParams": {
      "color": "#475569"
    },
    "actorClass": "truck",
    "id": "gallery.vehicle.flatbed_truck",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.flatbed_truck/model.glb",
      "contentHash": "636ebe81f8cc36d3824ec57d905304c646f941fe601feab552e77c7aa54a1a1b"
    }
  },
  {
    "label": "School bus",
    "class": "vehicle",
    "description": "Conventional yellow school bus for pupil loading, flashing-stop conflicts and child pedestrian occlusion scenarios.",
    "dims": {
      "l": 9.724976681368886,
      "w": 2.9218505584045933,
      "h": 3.1158541186034707
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "roadway",
      "large-vehicle",
      "service"
    ],
    "defaultParams": {
      "color": "#e8b51b"
    },
    "actorClass": "bus",
    "id": "gallery.vehicle.school_bus",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.school_bus/model.glb",
      "contentHash": "f2cf317768403f7d36805b519844e4ee9c3eff1f038164be5fbabf45d948c2e3"
    }
  },
  {
    "label": "Parcel delivery van",
    "class": "vehicle",
    "description": "Long-wheelbase parcel delivery van for frequent curb stops, double parking and driver-exit conflict scenarios.",
    "dims": {
      "l": 5.58265146365914,
      "w": 2.2325307021340666,
      "h": 2.6315752182804473
    },
    "tags": [
      "occlusion:high",
      "mobile",
      "parkable",
      "roadway",
      "delivery",
      "commercial"
    ],
    "defaultParams": {
      "color": "#8b5e3c"
    },
    "actorClass": "van",
    "id": "gallery.vehicle.delivery_van",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/vehicle.delivery_van/model.glb",
      "contentHash": "464d0dc1a16a1d9661120082f020555d4f51ca9defc94e55c4d87c4b25333c8a"
    }
  },
  {
    "label": "Adult pedestrian",
    "class": "pedestrian",
    "description": "Adult pedestrian, 1.75 m. Walking, standing and other motion are authored separately in the timeline.",
    "dims": {
      "l": 0.31855435949176963,
      "w": 1.70791366939143,
      "h": 1.75
    },
    "tags": [
      "vru",
      "occlusion:low",
      "sidewalk"
    ],
    "defaultParams": {
      "height": 1.75,
      "pose": "standing"
    },
    "id": "gallery.pedestrian.adult",
    "actorClass": "pedestrian",
    "animation": {
      "rig": "humanoid",
      "clips": [
        "idle",
        "walk",
        "run"
      ],
      "idleClip": "idle",
      "locomotionClip": "walk"
    },
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/pedestrian.adult/model.glb",
      "contentHash": "73d81c4885601f9a46067dc057ef6fc650632d6bf68bdc2dad4f24d54073d235",
      "animated": true,
      "clips": {
        "idle": "idle",
        "locomotion": "walk"
      },
      "clipAssets": {
        "idle": {
          "url": "/gallery-assets/pedestrian.adult/animations/idle.glb",
          "contentHash": "75586e733de382294cafa7b08cddb72fb2a453029d63324c705166f976abd3b7",
          "scale": 0.02
        },
        "locomotion": {
          "url": "/gallery-assets/pedestrian.adult/animations/walk.glb",
          "contentHash": "6950b8c6d0e79c000da433e30b8a9ca77894d9ec5060e7deec54b6f63a0ca683",
          "scale": 0.02
        },
        "run": {
          "url": "/gallery-assets/pedestrian.adult/animations/run.glb",
          "contentHash": "e14c60840f4f704a17a9847457d1f62c6b5ece024cf89876a58cd16e824b89df",
          "scale": 0.02
        },
        "rigged": {
          "url": "/gallery-assets/pedestrian.adult/animations/rigged.glb",
          "contentHash": "3a113e1732b6e27761b4e6273804fe4d1d1293235c835a10c47790e8b26c7e1f",
          "scale": 0.02
        }
      }
    }
  },
  {
    "label": "Child pedestrian",
    "class": "pedestrian",
    "description": "Child pedestrian with a 1.20 m stature and child-scaled physical/motion profile. Short enough to be hidden by a parked sedan.",
    "dims": {
      "l": 0.4439520528729213,
      "w": 0.8131952375222966,
      "h": 1.2
    },
    "tags": [
      "vru",
      "occlusion:low",
      "sidewalk"
    ],
    "defaultParams": {
      "height": 1.2,
      "pose": "standing",
      "massKg": 32,
      "walkSpeedMps": 1,
      "runSpeedMps": 3,
      "directionChangeImpulsiveness": 0.75
    },
    "id": "gallery.pedestrian.child",
    "actorClass": "pedestrian",
    "animation": {
      "rig": "humanoid",
      "clips": [
        "idle",
        "walk",
        "run"
      ],
      "idleClip": "idle",
      "locomotionClip": "walk"
    },
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/pedestrian.child/model.glb",
      "contentHash": "14252b07e6dcbd18629d0fd6a980ac489b1cf715136e63ef0dac424ee8f6f47c",
      "animated": true,
      "clips": {
        "idle": "idle",
        "locomotion": "walk"
      },
      "clipAssets": {
        "idle": {
          "url": "/gallery-assets/pedestrian.child/animations/idle.glb",
          "contentHash": "24de39abc31cb506fe1addeeebef711819fc364ebb032ea4a1162a29b38bc493",
          "scale": 0.02
        },
        "locomotion": {
          "url": "/gallery-assets/pedestrian.child/animations/walk.glb",
          "contentHash": "3e582154453e92fd88069c0e1fafd2c5994d3e066e6d144ef5fbbdcaca550c3d",
          "scale": 0.02
        },
        "run": {
          "url": "/gallery-assets/pedestrian.child/animations/run.glb",
          "contentHash": "d627418d89bebcc1100f48ab562ebe13908e301f373e91b42127f83cbb7e0053",
          "scale": 0.02
        },
        "rigged": {
          "url": "/gallery-assets/pedestrian.child/animations/rigged.glb",
          "contentHash": "c6eadaf0abb206c741567800fab31a7d035a2456a84c81b01509ba7eb47b779d",
          "scale": 0.02
        }
      }
    }
  },
  {
    "label": "Delivery rover",
    "class": "sidewalk_robot",
    "description": "Six-sensor autonomous delivery rover sized for pavements and crossings, with an animated wheel-and-lidar locomotion rig.",
    "dims": {
      "l": 0.8156864124853751,
      "w": 0.5071055145837803,
      "h": 0.8032595486812505
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "sidewalk",
      "autonomous",
      "delivery"
    ],
    "defaultParams": {
      "color": "#f1a34f"
    },
    "animation": {
      "rig": "wheeled",
      "clips": [
        "idle",
        "drive",
        "open_lid"
      ],
      "idleClip": "idle",
      "locomotionClip": "drive"
    },
    "id": "gallery.sidewalk_robot.delivery_rover",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/sidewalk_robot.delivery_rover/model.glb",
      "contentHash": "41fb54562d01157069bf91bb959ff29d9075d3cc216103a047fe239c5cc9c27a"
    }
  },
  {
    "label": "Food delivery cooler bot",
    "class": "sidewalk_robot",
    "description": "Large insulated food-delivery robot with animated wheels, suspension, lid, lights and sensor mast for busy-sidewalk scenes.",
    "dims": {
      "l": 0.7548151116426793,
      "w": 0.7209637144165051,
      "h": 1.131164321908224
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "sidewalk",
      "autonomous",
      "delivery"
    ],
    "defaultParams": {
      "color": "#edf1f4"
    },
    "animation": {
      "rig": "wheeled",
      "clips": [
        "idle",
        "drive",
        "open_lid"
      ],
      "idleClip": "idle",
      "locomotionClip": "drive"
    },
    "id": "gallery.sidewalk_robot.cooler_bot",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/sidewalk_robot.cooler_bot/model.glb",
      "contentHash": "4c1ef13c53a3cddc6c5c2ea72f4900a27d3a4a7cdb01e4aef286c02fbd85b9af"
    }
  },
  {
    "label": "Quadruped courier robot",
    "class": "sidewalk_robot",
    "description": "Four-legged autonomous courier robot with a cargo pod and articulated walk, idle-balance and sit animations.",
    "dims": {
      "l": 1.0711085366228792,
      "w": 0.5816231365398823,
      "h": 0.6206661132120797
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "sidewalk",
      "autonomous",
      "delivery"
    ],
    "defaultParams": {
      "color": "#e6b84f"
    },
    "animation": {
      "rig": "quadruped",
      "clips": [
        "idle",
        "walk",
        "sit"
      ],
      "idleClip": "idle",
      "locomotionClip": "walk"
    },
    "id": "gallery.sidewalk_robot.quadruped_courier",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/sidewalk_robot.quadruped_courier/model.glb",
      "contentHash": "40a68cf3c75c3a038db97a8e44c9f835eaac3a2f335362cbb2c3c6307947a642"
    }
  },
  {
    "label": "General-purpose humanoid",
    "class": "sidewalk_robot",
    "description": "Full-height bipedal service robot with articulated hands, head, torso and walking rig for general public-space scenarios.",
    "dims": {
      "l": 0.45080550196332325,
      "w": 0.7330590033131152,
      "h": 2.0515346220312223
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "sidewalk",
      "autonomous",
      "service"
    ],
    "defaultParams": {
      "color": "#e8edf2"
    },
    "animation": {
      "rig": "humanoid",
      "clips": [
        "idle",
        "walk",
        "run",
        "wave",
        "pick_up"
      ],
      "idleClip": "idle",
      "locomotionClip": "walk"
    },
    "id": "gallery.sidewalk_robot.humanoid_general_purpose",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/sidewalk_robot.humanoid_general_purpose/model.glb",
      "contentHash": "02c868a24003ee30387b9b6e43cb41e70c9dc1b17d92669c116fb35869c06d51"
    }
  },
  {
    "label": "Humanoid delivery robot",
    "class": "sidewalk_robot",
    "description": "Bipedal last-metre delivery robot carrying a parcel pod, animated for walking, handoff and door interaction scenes.",
    "dims": {
      "l": 0.47821227618875173,
      "w": 0.7953983735264611,
      "h": 2.0033299580130484
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "sidewalk",
      "autonomous",
      "delivery"
    ],
    "defaultParams": {
      "color": "#f0a44b"
    },
    "animation": {
      "rig": "humanoid",
      "clips": [
        "idle",
        "walk",
        "carry",
        "handoff",
        "open_door"
      ],
      "idleClip": "idle",
      "locomotionClip": "walk"
    },
    "id": "gallery.sidewalk_robot.humanoid_delivery",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/sidewalk_robot.humanoid_delivery/model.glb",
      "contentHash": "98bcec9ffb9df2fc4b095ff82be6fa5c9e2854d3d99908d979189afc8e569fa5"
    }
  },
  {
    "label": "Warehouse humanoid",
    "class": "sidewalk_robot",
    "description": "Industrial humanoid worker with protective limbs and grasping hands for loading docks, depots and logistics yards.",
    "dims": {
      "l": 0.4696598985921448,
      "w": 0.861524368333618,
      "h": 2.1217303052500105
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "sidewalk",
      "autonomous",
      "commercial"
    ],
    "defaultParams": {
      "color": "#d8a31a"
    },
    "animation": {
      "rig": "humanoid",
      "clips": [
        "idle",
        "walk",
        "lift",
        "carry",
        "place"
      ],
      "idleClip": "idle",
      "locomotionClip": "walk"
    },
    "id": "gallery.sidewalk_robot.humanoid_warehouse",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/sidewalk_robot.humanoid_warehouse/model.glb",
      "contentHash": "b2c862679e611e5ddf6737a4354dccec7b68bf4301fc72136363bbd6127d3375"
    }
  },
  {
    "label": "Construction humanoid",
    "class": "sidewalk_robot",
    "description": "Rugged humanoid work robot with a safety helmet and tool mount for roadworks, inspection and repair operations.",
    "dims": {
      "l": 0.5674789528031254,
      "w": 0.8567921263381261,
      "h": 1.8562790232240922
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "sidewalk",
      "autonomous",
      "workzone",
      "service"
    ],
    "defaultParams": {
      "color": "#f59e0b"
    },
    "animation": {
      "rig": "humanoid",
      "clips": [
        "idle",
        "walk",
        "carry_tool",
        "inspect",
        "kneel"
      ],
      "idleClip": "idle",
      "locomotionClip": "walk"
    },
    "id": "gallery.sidewalk_robot.humanoid_construction",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/sidewalk_robot.humanoid_construction/model.glb",
      "contentHash": "225347a19e8e2e8a454ddefb6707408c3437ab680766948e0a8e3828a8764c76"
    }
  },
  {
    "label": "Camera drone",
    "class": "drone",
    "description": "Compact camera quadcopter with animated rotors and gimbal for filming, inspection and low-altitude perception scenarios.",
    "dims": {
      "l": 0.7262695569676771,
      "w": 0.7021954419055968,
      "h": 0.2713365307666242
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "aerial",
      "autonomous"
    ],
    "defaultParams": {
      "color": "#343a42"
    },
    "animation": {
      "rig": "rotorcraft",
      "clips": [
        "idle",
        "fly",
        "orbit",
        "land"
      ],
      "idleClip": "idle",
      "locomotionClip": "fly",
      "hoverHeightM": 4
    },
    "id": "gallery.drone.camera_quadcopter",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/drone.camera_quadcopter/model.glb",
      "contentHash": "a843c19968c6723f390671e36d8d1b32b36d22b249ebbac3181978a5b3d570a1"
    }
  },
  {
    "label": "Cat",
    "class": "animal",
    "description": "Domestic cat with idle, walk, run and crouch clips for small, easily occluded sidewalk and roadway conflicts.",
    "dims": {
      "l": 0.5475100724788444,
      "w": 0.14416212051714924,
      "h": 0.43271792666076603
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "vru",
      "sidewalk",
      "domestic"
    ],
    "defaultParams": {
      "color": "#5c5750"
    },
    "animation": {
      "rig": "quadruped",
      "clips": [
        "idle",
        "walk",
        "run",
        "crouch"
      ],
      "idleClip": "idle",
      "locomotionClip": "walk"
    },
    "id": "gallery.animal.cat",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/animal.cat/model.glb",
      "contentHash": "458da000e87b5719d938027cf3986be03a72912fade16c96c1a9e18a5194c3e1"
    }
  },
  {
    "label": "Deer",
    "class": "animal",
    "description": "Adult deer with alert-idle, walk and bound clips for high-severity wildlife incursions on suburban and rural roads.",
    "dims": {
      "l": 1.5038957584597408,
      "w": 0.5410670552515218,
      "h": 1.6538472519675678
    },
    "tags": [
      "occlusion:medium",
      "mobile",
      "vru",
      "roadside",
      "wildlife"
    ],
    "defaultParams": {
      "color": "#9c7b52"
    },
    "animation": {
      "rig": "quadruped",
      "clips": [
        "alert_idle",
        "walk",
        "bound"
      ],
      "idleClip": "alert_idle",
      "locomotionClip": "walk"
    },
    "id": "gallery.animal.deer",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/animal.deer/model.glb",
      "contentHash": "b90f7787ebc4bdd8106271b7ac8b1211d15f7ccd2a6a882e4efc631f7ec0795e"
    }
  },
  {
    "label": "Goose",
    "class": "animal",
    "description": "Adult goose with idle, waddle, run and wing-display clips for flock crossings near parks, ponds and campuses.",
    "dims": {
      "l": 1.0392161085597715,
      "w": 0.3684919828593605,
      "h": 1.0422139019920242
    },
    "tags": [
      "occlusion:low",
      "mobile",
      "vru",
      "sidewalk",
      "wildlife"
    ],
    "defaultParams": {
      "color": "#d8d8cf"
    },
    "animation": {
      "rig": "avian",
      "clips": [
        "idle",
        "waddle",
        "run",
        "wing_display"
      ],
      "idleClip": "idle",
      "locomotionClip": "waddle"
    },
    "id": "gallery.animal.goose",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/animal.goose/model.glb",
      "contentHash": "151acee83d5661095d617bc86d6c1fe41eb297751b6ed7d5382e5f0869d32b8a"
    }
  },
  {
    "label": "Traffic cone",
    "class": "construction",
    "description": "Standard 700 mm orange channelizing cone with two reflective bands. The unit of any taper or lane closure.",
    "dims": {
      "l": 0.37137985271642626,
      "w": 0.309998330694776,
      "h": 0.8052034471850222
    },
    "tags": [
      "workzone",
      "occlusion:low",
      "roadway"
    ],
    "defaultParams": {
      "height": 0.7
    },
    "id": "gallery.construction.traffic_cone",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/construction.traffic_cone/model.glb",
      "contentHash": "a521ace58009c790be9bb478447f0153dea0fb1ed0ec24752898d7b82c5ce557"
    }
  },
  {
    "label": "Type III barricade",
    "class": "construction",
    "description": "Full 8 ft type-III barricade with three striped rails and a warning light. Used to close a road or a ramp outright.",
    "dims": {
      "l": 0.5590905388677472,
      "w": 2.926306709851147,
      "h": 1.570125038720545
    },
    "tags": [
      "workzone",
      "occlusion:medium",
      "roadway"
    ],
    "defaultParams": {},
    "id": "gallery.construction.barricade_type3",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/construction.barricade_type3/model.glb",
      "contentHash": "044063e875b589797c26aa9b54ff273eb65738ba4a1023e3ffc4f80cd6292146"
    }
  },
  {
    "label": "Excavator",
    "class": "construction",
    "description": "Tracked excavator with the boom stowed forward. A large static machine inside a work area; blocks sightlines completely.",
    "dims": {
      "l": 4.914250196156176,
      "w": 1.9029569913471356,
      "h": 3.4971717475731854
    },
    "tags": [
      "workzone",
      "occlusion:high",
      "roadway",
      "large-vehicle"
    ],
    "defaultParams": {},
    "id": "gallery.construction.excavator",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/construction.excavator/model.glb",
      "contentHash": "5c0ca3f13643ddd9b2bca5cd08af10a927a860627f129af2b86a3b4e91d447bb"
    }
  },
  {
    "label": "Spoil pile",
    "class": "construction",
    "description": "Heap of excavated soil and broken pavement. Low, irregular obstacle that narrows the drivable surface.",
    "dims": {
      "l": 2.790973447975233,
      "w": 2.8211744663828737,
      "h": 0.7728330189142807
    },
    "tags": [
      "workzone",
      "occlusion:low",
      "roadway"
    ],
    "defaultParams": {
      "length": 2.5,
      "height": 0.9,
      "seed": 7
    },
    "id": "gallery.construction.spoil_pile",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/construction.spoil_pile/model.glb",
      "contentHash": "82c6d0b085b11e2e9d49d4d16766ab26b8c24b900d3f09027152d301cbce828d"
    }
  },
  {
    "label": "Covered car",
    "class": "occluder",
    "description": "Car under a fitted cover: a vehicle-sized mass that is deliberately not classifiable as a vehicle model. Long-term parked.",
    "dims": {
      "l": 4.561962092379933,
      "w": 1.9568347518114935,
      "h": 1.4656957392294006
    },
    "tags": [
      "occlusion:medium",
      "roadside",
      "parkable"
    ],
    "defaultParams": {},
    "id": "gallery.occluder.covered_car",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/occluder.covered_car/model.glb",
      "contentHash": "921c4b1a371ceef4401fa4317aa287b723cc6985cf81397d5ae4951e34e316f4"
    }
  },
  {
    "label": "Mailbox cluster",
    "class": "street",
    "description": "Pedestal-mounted cluster mailbox unit with the doors facing +X. Small sidewalk fixture; a reason for pedestrians to stop at a kerb.",
    "dims": {
      "l": 0.5552598561308111,
      "w": 0.8298996424572,
      "h": 1.7953815557796413
    },
    "tags": [
      "occlusion:low",
      "sidewalk"
    ],
    "defaultParams": {},
    "id": "gallery.street.mailbox_cluster",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/street.mailbox_cluster/model.glb",
      "contentHash": "f7a4c614ba95ddc7f50a326055b2b4e49ceaed21519521420f82d0ca0f334e03"
    }
  },
  {
    "label": "Bus shelter",
    "class": "street",
    "description": "Glazed transit shelter with a bench, open on the kerb (+Z) side. Hides waiting pedestrians until they step out.",
    "dims": {
      "l": 3.6958653231310055,
      "w": 1.7234571425981589,
      "h": 2.5269297216533113
    },
    "tags": [
      "occlusion:high",
      "sidewalk"
    ],
    "defaultParams": {},
    "id": "gallery.street.bus_shelter",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/street.bus_shelter/model.glb",
      "contentHash": "c3ed25e57bd93719ac433d30a718774219ae1536744f5ae9c67fa5f69fcc9ef7"
    }
  },
  {
    "label": "Food cart",
    "class": "street",
    "description": "Sidewalk vending cart with a canopy. Draws a queue of pedestrians onto the kerb and blocks the view down the footway.",
    "dims": {
      "l": 2.1066989356928048,
      "w": 1.105363267104949,
      "h": 1.7840838050600596
    },
    "tags": [
      "occlusion:medium",
      "sidewalk"
    ],
    "defaultParams": {},
    "id": "gallery.street.food_cart",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/street.food_cart/model.glb",
      "contentHash": "aa03473c564af62f1436e9825c20d71b51325cd24f5b0974bafa45a2a3cc74cf"
    }
  },
  {
    "label": "Shopping cart",
    "class": "street",
    "description": "Small rolling wire shopping cart that can enter a roadway from a kerb or parking area and create a low-mass obstacle conflict.",
    "dims": {
      "l": 1.1445610861046167,
      "w": 0.6015464283703851,
      "h": 1.047831593844533
    },
    "tags": [
      "debris",
      "mobile",
      "occlusion:low",
      "roadway"
    ],
    "defaultParams": {},
    "actorClass": "scooter",
    "id": "gallery.street.shopping_cart",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/street.shopping_cart/model.glb",
      "contentHash": "df0edd705f40bff5ec2206a672f67c0ad6960cae85a923f63c2a2cd497a4c863"
    }
  },
  {
    "label": "Tyre debris",
    "class": "hazard",
    "description": "Shredded truck retread lying in the lane. Small dark object that must be classified as drivable-over rather than braked for.",
    "dims": {
      "l": 0.6892244868319328,
      "w": 0.6869082722380968,
      "h": 0.21600558829205652
    },
    "tags": [
      "debris",
      "roadway",
      "occlusion:low"
    ],
    "defaultParams": {},
    "id": "gallery.hazard.tire_debris",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/hazard.tire_debris/model.glb",
      "contentHash": "696162aec0a4da4be3daa85cec1fd42341e1e6d4d7a04ffc8ed72e9f116ce0d8"
    }
  },
  {
    "label": "Cardboard box",
    "class": "hazard",
    "description": "Empty cardboard box with open flaps. The canonical false-positive obstacle: large enough to trigger a brake, light enough to ignore.",
    "dims": {
      "l": 0.6775553163717474,
      "w": 0.5006600814507979,
      "h": 0.3714999342688262
    },
    "tags": [
      "debris",
      "roadway",
      "occlusion:low"
    ],
    "defaultParams": {},
    "id": "gallery.hazard.cardboard_box",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/hazard.cardboard_box/model.glb",
      "contentHash": "50341b05508420375f4766a0bafd0554908a3b1d844da2a093c7a5956144e978"
    }
  },
  {
    "label": "Refuse sacks",
    "class": "hazard",
    "description": "Cluster of tied rubbish bags at the kerb. Ambiguous low mass that narrows the usable lane on collection day.",
    "dims": {
      "l": 1.0632995848153541,
      "w": 1.062837265857363,
      "h": 0.497552752034059
    },
    "tags": [
      "debris",
      "roadside",
      "occlusion:low"
    ],
    "defaultParams": {
      "count": 3,
      "seed": 11
    },
    "id": "gallery.hazard.trash_bags",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/hazard.trash_bags/model.glb",
      "contentHash": "b050b8bedbcaa030433ddb251d9869d2904ac2affc6d6ed1e1819687025fb2d7"
    }
  },
  {
    "label": "Fallen ladder",
    "class": "hazard",
    "description": "Aluminium extension ladder shed from a roof rack, lying across the carriageway. Long, thin and low: too long to straddle and hard to see at range.",
    "dims": {
      "l": 2.9904106656248772,
      "w": 0.4793533865022064,
      "h": 0.08938858166359642
    },
    "tags": [
      "debris",
      "roadway",
      "occlusion:low"
    ],
    "defaultParams": {},
    "id": "gallery.hazard.ladder",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/hazard.ladder/model.glb",
      "contentHash": "9e476d780831f58abe4c38c134fa72f47923faf72b7d96684b1934f561f81a53"
    }
  },
  {
    "label": "Unidentified debris",
    "class": "hazard",
    "description": "Scatter of broken material in the travelled way with no recognisable identity. The generic obstacle for briefs that say \"there is debris in the lane\" without naming the object.",
    "dims": {
      "l": 1.0099191096928246,
      "w": 0.9177924900716039,
      "h": 0.19958290332847095
    },
    "tags": [
      "debris",
      "roadway",
      "occlusion:low"
    ],
    "defaultParams": {},
    "id": "gallery.hazard.debris",
    "model": {
      "kind": "glb",
      "url": "/gallery-assets/hazard.debris/model.glb",
      "contentHash": "53d539cfdb0ddd85c861b3c8d71f8e669d5f593cdc1df9a114204e35fbd7b8ce"
    }
  }
] as const satisfies readonly ExternalCatalogEntry[];
