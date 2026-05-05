// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "ConductorMenu",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(name: "ConductorMenu", targets: ["ConductorMenu"]),
  ],
  targets: [
    .executableTarget(name: "ConductorMenu"),
  ]
)
