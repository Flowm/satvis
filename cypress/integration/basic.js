describe("Basic tests", function() {
  it("Cesium and UI visible", function() {
    cy.visit("/");

    cy.get("#cesiumContainer");

    cy.get(".app").get(".svg-sat").click()
    cy.get(".toolbarSwitches").should("be.visible");
    cy.get(".app").contains("Tracked satellite");

    cy.get(".app").get(".svg-sat").click();
    cy.get(".toolbarSwitches").should("not.visible");
  })
})
