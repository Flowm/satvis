import { CesiumController } from "../modules/CesiumController";

const VueCesiumController = {
  install(Vue) {
    Vue.prototype.cc = new CesiumController();
  }
};
export default VueCesiumController;
