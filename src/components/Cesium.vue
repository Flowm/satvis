<template>
  <div class="cesium">
    <div v-if="showUI" id="toolbarLeft">
      <div class="toolbarButtons">
        <b-tooltip label="Satellite selection" position="is-right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('cat')">
            <span class="icon fill-parent">
              <i class="svg-sat"></i>
            </span>
          </button>
        </b-tooltip>
        <b-tooltip label="Satellite elements" position="is-right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('sat')">
            <span class="icon fill-parent">
              <i class="fas fa-layer-group fa-2x"></i>
            </span>
          </button>
        </b-tooltip>
        <b-tooltip label="Ground station" position="is-right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('gs')">
            <span class="icon fill-parent">
              <i class="svg-groundstation"></i>
            </span>
          </button>
        </b-tooltip>
        <b-tooltip label="Map" position="is-right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('map')">
            <span class="icon fill-parent">
              <i class="fas fa-globe-africa fa-2x"></i>
            </span>
          </button>
        </b-tooltip>
        <b-tooltip v-if="cc.minimalUI" label="Mobile" position="is-right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('ios')">
            <span class="icon fill-parent">
              <i class="fas fa-mobile-alt fa-2x"></i>
            </span>
          </button>
        </b-tooltip>
        <b-tooltip label="Debug" position="is-right">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('dbg')">
            <span class="icon fill-parent">
              <i class="fas fa-hammer fa-fw mfa-button-width"></i>
            </span>
          </button>
        </b-tooltip>
      </div>
      <div v-show="menu.cat" class="toolbarSwitches">
        <div class="toolbarTitle">Tracked satellite</div>
        <div class="toolbarContent">
          <satellite-select ref="SatelliteSelect" />
        </div>
        <div class="toolbarTitle">Enabled satellites</div>
        <div class="toolbarContent">
          <satellite-multi-select ref="SatelliteMultiSelect" />
        </div>
        <div class="toolbarTitle">Monitored satellites</div>
        <div class="toolbarContent">
          <satellite-notify-multi-select ref="SatelliteNotifyMultiSelect" />
        </div>
      </div>
      <div v-show="menu.sat" class="toolbarSwitches">
        <div class="toolbarTitle">Satellite elements</div>
        <label v-for="componentName in cc.sats.components" :key="componentName" class="toolbarSwitch">
          <input v-model="enabledComponents" type="checkbox" :value="componentName">
          <span class="slider"></span>
          {{ componentName }}
        </label>
        <!--
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.trackedEntity = undefined">
          Untrack Entity
        </label>
        -->
      </div>
      <div v-show="menu.gs" class="toolbarSwitches">
        <div class="toolbarTitle">Ground station</div>
        <label class="toolbarSwitch">
          <input v-model="groundStationPicker.enabled" type="checkbox">
          <span class="slider"></span>
          Pick on globe
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.setGroundStationFromGeolocation()">
          Set from geolocation
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.sats.focusGroundStation()">
          Focus
        </label>
      </div>
      <div v-show="menu.map" class="toolbarSwitches">
        <div class="toolbarTitle">View</div>
        <label v-for="name in cc.sceneModes" :key="name" class="toolbarSwitch">
          <input v-model="sceneMode" type="radio" :value="name">
          <span class="slider"></span>
          {{ name }}
        </label>
        <div class="toolbarTitle">Imagery</div>
        <label v-for="name in cc.imageryProviders" :key="name" class="toolbarSwitch">
          <input v-model="imageryProvider" type="radio" :value="name">
          <span class="slider"></span>
          {{ name }}
        </label>
      </div>
      <div v-show="menu.ios" class="toolbarSwitches">
        <div class="toolbarTitle">Mobile</div>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.useWebVR" type="checkbox">
          <span class="slider"></span>
          VR
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.clock.shouldAnimate" type="checkbox">
          <span class="slider"></span>
          Play
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier *= 2">
          Increase play speed
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier /= 2">
          Decrease play speed
        </label>
      </div>
      <div v-show="menu.dbg" class="toolbarSwitches">
        <div class="toolbarTitle">Debug</div>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.debugShowFramesPerSecond" type="checkbox">
          <span class="slider"></span>
          FPS
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.requestRenderMode" type="checkbox">
          <span class="slider"></span>
          RequestRender
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.fog.enabled" type="checkbox">
          <span class="slider"></span>
          Fog
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.enableLighting" type="checkbox">
          <span class="slider"></span>
          Lighting
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.showGroundAtmosphere" type="checkbox">
          <span class="slider"></span>
          Atmosphere
        </label>
      </div>
    </div>
    <div id="toolbarRight">
      <b-tooltip v-if="showUI" label="Github" position="is-left">
        <a class="cesium-button cesium-toolbar-button" href="https://github.com/Flowm/satvis/" target="_blank" rel="noopener">
          <span class="icon fill-parent">
            <i class="fab fa-github fa-2x"></i>
          </span>
        </a>
      </b-tooltip>
      <b-tooltip label="Toggle UI" position="is-left">
        <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleUI">
          <span class="icon fill-parent">
            <i class="fas fa-eye fa-2x"></i>
          </span>
        </button>
      </b-tooltip>
    </div>
  </div>
</template>

<script>
import Vue from "vue";
import Buefy from "buefy";
import SatelliteSelect from "./SatelliteSelect.vue";
import SatelliteMultiSelect from "./SatelliteMultiSelect.vue";
import SatelliteNotifyMultiSelect from "./SatelliteNotifyMultiSelect.vue";
import VueCesiumController from "./VueCesiumController.js";
Vue.use(Buefy);
Vue.use(VueCesiumController); /* global cc */

export default {
  components: {
    "satellite-select": SatelliteSelect,
    "satellite-multi-select": SatelliteMultiSelect,
    "satellite-notify-multi-select": SatelliteNotifyMultiSelect,
  },
  data() {
    return {
      menu: {
        cat: false,
        sat: false,
        gs: false,
        map: false,
        ios: false,
        dbg: false,
      },
      showUI: true,
      imageryProvider: "Offline",
      sceneMode: "3D",
      enabledComponents: cc.sats.enabledComponents,
      groundStationPicker: cc.groundStationPicker,
    };
  },
  watch: {
    imageryProvider: function(newProvider) {
      cc.imageryProvider = newProvider;
      this.$router.push({query: {...this.$route.query, imagery: newProvider}});
    },
    sceneMode: function(newMode) {
      cc.sceneMode = newMode;
    },
    enabledComponents: function(newComponents, oldComponents) {
      let add = newComponents.filter(x => !oldComponents.includes(x));
      for (let component of add) {
        cc.sats.enableComponent(component);
      }
      let del = oldComponents.filter(x => !newComponents.includes(x));
      for (let component of del) {
        cc.sats.disableComponent(component);
      }
    },
  },
  mounted() {
    if (this.$route.query.gs) {
      cc.setGroundStationFromLatLon(this.$route.query.gs);
    }
    if (this.$route.query.imagery) {
      cc.imageryProvider = this.$route.query.imagery;
    }
    if (this.$route.query.elements) {
      const elements = this.$route.query.elements.replace(/_/g, " ").split(",");
      this.enabledComponents = [...new Set(this.enabledComponents.concat(...elements))];
    }
    this.showUI = !cc.minimalUIAtStartup;
    this.$root.$on("updateCat", this.updateCat);
  },
  beforeDestroy() {
    this.$root.$off("updateCat", this.updateCat);
  },
  methods: {
    toggleMenu: function(name) {
      const oldState = this.menu[name];
      Object.keys(this.menu).forEach(k => this.menu[k] = false);
      this.menu[name] = !oldState;

      if (this.menu.cat) {
        // Update multiselect data when it is displayed
        this.updateCat();
      }
    },
    toggleUI: function() {
      this.showUI = !this.showUI;
      if (!cc.minimalUI) {
        cc.showUI = this.showUI;
      }
    },
    updateCat: function() {
      this.$refs.SatelliteSelect.update();
      this.$refs.SatelliteMultiSelect.update();
      this.$refs.SatelliteNotifyMultiSelect.update();
    },
  },
};
</script>
