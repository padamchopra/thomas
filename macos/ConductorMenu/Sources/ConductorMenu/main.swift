import AppKit
import Foundation

struct ConductorState: Decodable {
  let cliVersion: String?
  let generatedAt: String?
  let configPath: String
  let projects: [Project]
  let workspaces: [Workspace]
  let sessions: [Session]
  let settings: SettingsState?
}

struct Project: Decodable {
  let name: String
  let repoPath: String
  let mainBranch: String?
  let worktreesDir: String?
  let githubUser: String?
  let agentProfile: String?
  let claudeProfile: String?
}

struct Workspace: Decodable {
  let name: String
  let project: String
  let path: String
  let branch: String
  let status: String
  let prUrl: String?
}

struct Session: Decodable {
  let id: String
  let project: String
  let workspace: String
  let agent: String
  let status: String
  let cwd: String?
  let runCommand: String?
  let resumeCommand: String?
}

struct SettingsState: Decodable {
  let terminalApp: String?
  let notifications: NotificationSettings?
  let agentHooks: AgentHooksState?
  let agentProfiles: AgentProfilesState?
  let claudeProfiles: ClaudeProfilesState?
}

struct AgentProfilesState: Decodable {
  let `default`: String?
  let profiles: [String: AgentProfileState]?
}

typealias ClaudeProfilesState = AgentProfilesState

struct AgentProfileState: Decodable {
  let name: String?
  let command: String
}

struct NotificationSettings: Decodable {
  let enabled: Bool?
  let soundName: String?
  let macosNotification: Bool?
}

struct AgentHooksState: Decodable {
  let claude: HookInstallState?
  let codex: HookInstallState?
}

struct HookInstallState: Decodable {
  let installedAt: String?
}

enum ConductorCommand {
  case executable(String)
  case nodeScript(String)
}

struct CommandError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

struct RegistrationForm {
  let name: String
  let base: String
  let githubUser: String
  let worktreesDir: String
  let agentProfile: String
}

struct WorkspaceCreationForm {
  let name: String
  let base: String
  let agent: String
}

struct AgentProfileForm {
  let name: String
  let command: String
}

final class ConductorService {
  let command: ConductorCommand
  let nodePath: String?
  let autoTerminalApp: String
  let processEnvironment: [String: String]

  init() {
    self.nodePath = Self.resolveNodePath()
    self.autoTerminalApp = Self.resolvePreferredTerminal()
    self.processEnvironment = Self.defaultProcessEnvironment(nodePath: self.nodePath)
    self.command = Self.resolveCommand()
  }

  func loadState() throws -> ConductorState {
    let output = try run(["state"])
    guard let data = output.data(using: .utf8) else {
      throw CommandError(message: "conductor-cli returned invalid text")
    }
    return try JSONDecoder().decode(ConductorState.self, from: data)
  }

  @discardableResult
  func run(_ arguments: [String]) throws -> String {
    let process = Process()
    switch command {
    case .executable(let path):
      process.executableURL = URL(fileURLWithPath: path)
      process.arguments = arguments
    case .nodeScript(let path):
      guard let nodePath else {
        throw CommandError(
          message: "Node.js was not found. Install Node or set CONDUCTOR_NODE_BIN."
        )
      }
      process.executableURL = URL(fileURLWithPath: nodePath)
      process.arguments = [path] + arguments
    }
    process.environment = processEnvironment

    let output = Pipe()
    let error = Pipe()
    process.standardOutput = output
    process.standardError = error

    try process.run()
    process.waitUntilExit()

    let stdout = String(
      data: output.fileHandleForReading.readDataToEndOfFile(),
      encoding: .utf8
    ) ?? ""
    let stderr = String(
      data: error.fileHandleForReading.readDataToEndOfFile(),
      encoding: .utf8
    ) ?? ""

    guard process.terminationStatus == 0 else {
      let message = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
      throw CommandError(message: message.isEmpty ? stdout : message)
    }

    return stdout
  }

  func commandDescription() -> String {
    switch command {
    case .executable(let path):
      return path
    case .nodeScript(let path):
      return "\(nodePath ?? "node") \(path)"
    }
  }

  func terminalArgument(for setting: String?) -> String {
    Self.normalizeTerminalName(setting ?? "auto") ?? "auto"
  }

  func terminalDescription(for setting: String?) -> String {
    let terminal = terminalArgument(for: setting)
    if terminal == "auto" {
      return "Auto (\(terminalLabel(autoTerminalApp)))"
    }
    return terminalLabel(terminal)
  }

  private func terminalLabel(_ terminal: String) -> String {
    switch terminal {
    case "warp":
      return "Warp"
    case "warppreview":
      return "Warp Preview"
    case "iterm":
      return "iTerm"
    default:
      return "Terminal"
    }
  }

  private static func resolveCommand() -> ConductorCommand {
    let environment = ProcessInfo.processInfo.environment
    if let explicit = environment["CONDUCTOR_CLI_BIN"], !explicit.isEmpty {
      return command(for: explicit)
    }

    if let bundled = Bundle.main.resourceURL?
      .appendingPathComponent("bin")
      .appendingPathComponent("conductor-cli.js")
      .path,
      FileManager.default.fileExists(atPath: bundled) {
      return command(for: bundled)
    }

    if let resourcePath = Bundle.main.path(
      forResource: "conductor-cli-path",
      ofType: "txt"
    ),
      let contents = try? String(contentsOfFile: resourcePath, encoding: .utf8) {
      let path = contents.trimmingCharacters(in: .whitespacesAndNewlines)
      if FileManager.default.fileExists(atPath: path) {
        return command(for: path)
      }
    }

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let installed = [
      "/usr/local/bin/conductor-cli",
      "\(home)/.local/bin/conductor-cli",
    ]
    for path in installed where FileManager.default.isExecutableFile(atPath: path) {
      return .executable(path)
    }

    let sourceURL = URL(fileURLWithPath: #filePath)
    let repoRoot = sourceURL
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let repoScript = repoRoot.appendingPathComponent("bin/conductor-cli.js").path
    return command(for: repoScript)
  }

  private static func command(for path: String) -> ConductorCommand {
    path.hasSuffix(".js") ? .nodeScript(path) : .executable(path)
  }

  private static func resolveNodePath() -> String? {
    let environment = ProcessInfo.processInfo.environment
    if let explicit = environment["CONDUCTOR_NODE_BIN"],
      FileManager.default.isExecutableFile(atPath: explicit) {
      return explicit
    }

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let candidates = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "\(home)/.local/bin/node",
      "\(home)/.nvm/current/bin/node",
      "/usr/bin/node",
    ]
    for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
      return path
    }

    return loginShellPath(for: "node")
  }

  private static func resolvePreferredTerminal() -> String {
    let environment = ProcessInfo.processInfo.environment
    for key in ["CONDUCTOR_TERMINAL_APP", "CONDUCTOR_CLI_TERMINAL"] {
      if let explicit = environment[key],
        let terminal = normalizeTerminalName(explicit),
        terminal != "auto" {
        return terminal
      }
    }

    if applicationExists(named: "Warp.app") { return "warp" }
    if applicationExists(named: "Warp Preview.app") { return "warppreview" }
    if applicationExists(named: "iTerm.app") || applicationExists(named: "iTerm2.app") {
      return "iterm"
    }
    return "terminal"
  }

  private static func normalizeTerminalName(_ value: String) -> String? {
    switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "auto":
      return "auto"
    case "terminal", "terminal.app", "apple", "apple_terminal":
      return "terminal"
    case "iterm", "iterm2", "iterm.app":
      return "iterm"
    case "warp":
      return "warp"
    case "warppreview", "warp-preview", "warp preview":
      return "warppreview"
    default:
      return nil
    }
  }

  private static func applicationExists(named appName: String) -> Bool {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let paths = [
      "/Applications/\(appName)",
      "\(home)/Applications/\(appName)",
    ]
    return paths.contains { FileManager.default.fileExists(atPath: $0) }
  }

  private static func loginShellPath(for command: String) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-lc", "command -v \(command)"]

    let output = Pipe()
    process.standardOutput = output
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
    } catch {
      return nil
    }

    guard process.terminationStatus == 0 else { return nil }
    let text = String(
      data: output.fileHandleForReading.readDataToEndOfFile(),
      encoding: .utf8
    ) ?? ""
    let path = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return path.isEmpty ? nil : path
  }

  private static func defaultProcessEnvironment(nodePath: String?) -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let extraPaths = [
      nodePath.map { URL(fileURLWithPath: $0).deletingLastPathComponent().path },
      "\(home)/.local/bin",
      "\(home)/.claude/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].compactMap { $0 }

    let existing = (environment["PATH"] ?? "")
      .split(separator: ":")
      .map(String.init)
    var seen = Set<String>()
    let path = (extraPaths + existing).filter { part in
      guard !part.isEmpty && !seen.contains(part) else { return false }
      seen.insert(part)
      return true
    }.joined(separator: ":")

    environment["PATH"] = path
    return environment
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
  private let service = ConductorService()
  private let statusItem = NSStatusBar.system.statusItem(
    withLength: NSStatusItem.variableLength
  )
  private var state: ConductorState?
  private var lastError: String?
  private var refreshTimer: Timer?
  private weak var pendingWorkspaceNameField: NSTextField?
  private weak var pendingWorkspaceBranchPreview: NSTextField?
  private var pendingWorkspaceProjectName: String?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    configureStatusItem()
    refresh()
    refreshTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) {
      [weak self] _ in self?.refresh(silent: true)
    }
  }

  private func configureStatusItem() {
    guard let button = statusItem.button else { return }
    if let image = NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted", accessibilityDescription: "Conductor") {
      image.isTemplate = true
      button.image = image
    } else if let image = NSImage(systemSymbolName: "terminal", accessibilityDescription: "Conductor") {
      image.isTemplate = true
      button.image = image
    } else {
      button.title = "C"
    }
    button.toolTip = "Conductor"
  }

  @objc private func refreshAction(_ sender: Any?) {
    refresh()
  }

  private func refresh(silent: Bool = false) {
    do {
      state = try service.loadState()
      lastError = nil
    } catch {
      lastError = error.localizedDescription
      if !silent {
        showError(title: "Unable to load conductor-cli state", message: lastError ?? "")
      }
    }
    buildMenu()
  }

  private func buildMenu() {
    let menu = NSMenu()
    menu.addItem(disabledItem("Conductor"))
    menu.addItem(disabledItem(service.commandDescription()))
    menu.addItem(disabledItem("Terminal: \(service.terminalDescription(for: currentTerminalSetting()))"))
    menu.addItem(.separator())

    if let lastError {
      menu.addItem(disabledItem("Error: \(lastError)"))
      menu.addItem(.separator())
    }

    if let state {
      if state.projects.isEmpty {
        menu.addItem(disabledItem("No registered projects"))
      } else {
        menu.addItem(disabledItem("Projects"))
        for project in state.projects.sorted(by: { $0.name < $1.name }) {
          let item = NSMenuItem(
            title: project.name,
            action: nil,
            keyEquivalent: ""
          )
          item.submenu = projectMenu(project)
          menu.addItem(item)
        }
      }

      menu.addItem(actionItem("Register Project...", action: #selector(registerProject(_:))))
      menu.addItem(.separator())

      let activeWorkspaces = state.workspaces
        .filter { $0.status == "active" }
        .sorted { "\($0.project)/\($0.name)" < "\($1.project)/\($1.name)" }

      if activeWorkspaces.isEmpty {
        menu.addItem(disabledItem("No active workspaces"))
      } else {
        menu.addItem(disabledItem("Active Workspaces"))
        for workspace in activeWorkspaces.prefix(25) {
          let item = NSMenuItem(
            title: "\(workspace.project)/\(workspace.name)",
            action: nil,
            keyEquivalent: ""
          )
          item.submenu = workspaceMenu(workspace)
          menu.addItem(item)
        }
        if activeWorkspaces.count > 25 {
          menu.addItem(disabledItem("\(activeWorkspaces.count - 25) more workspaces"))
        }
      }

      let runningSessions = state.sessions
        .filter { ["ready", "running", "opened", "attached"].contains($0.status) }
      if !runningSessions.isEmpty {
        menu.addItem(.separator())
        menu.addItem(disabledItem("Sessions"))
        for session in runningSessions.prefix(8) {
          let item = NSMenuItem(
            title: "\(session.agent): \(session.project)/\(session.workspace)",
            action: nil,
            keyEquivalent: ""
          )
          item.submenu = sessionMenu(session)
          menu.addItem(item)
        }
        if runningSessions.count > 8 {
          menu.addItem(disabledItem("+ \(runningSessions.count - 8) more sessions"))
        }
        menu.addItem(
          actionItem(
            "Close All Sessions...",
            action: #selector(closeAllSessions(_:)),
            object: runningSessions.map(\.id)
          )
        )
      }

      menu.addItem(.separator())
      let settingsItem = NSMenuItem(title: "Settings", action: nil, keyEquivalent: "")
      settingsItem.submenu = settingsMenu(state.settings)
      menu.addItem(settingsItem)
    }

    menu.addItem(.separator())
    menu.addItem(actionItem("Refresh", action: #selector(refreshAction(_:))))
    menu.addItem(actionItem("Open Config Folder", action: #selector(openConfigFolder(_:))))
    menu.addItem(actionItem("Open Worktrees Folder", action: #selector(openWorktreesFolder(_:))))
    menu.addItem(.separator())
    menu.addItem(actionItem("Quit", action: #selector(quit(_:))))
    statusItem.menu = menu
  }

  private func projectMenu(_ project: Project) -> NSMenu {
    let menu = NSMenu()
    menu.addItem(disabledItem(project.repoPath))
    menu.addItem(disabledItem("Base: \(project.mainBranch ?? "origin/main")"))
    if let worktreesDir = project.worktreesDir {
      menu.addItem(disabledItem("Worktrees: \(worktreesDir)"))
    }
    menu.addItem(disabledItem("Agent: \(projectAgentProfileLabel(project))"))
    menu.addItem(.separator())
    menu.addItem(
      actionItem(
        "Set Agent Profile...",
        action: #selector(setProjectAgentProfile(_:)),
        object: projectObject(project)
      )
    )
    menu.addItem(.separator())
    menu.addItem(
      actionItem(
        "Create Workspace...",
        action: #selector(createWorkspace(_:)),
        object: projectObject(project)
      )
    )
    menu.addItem(.separator())

    let projectWorkspaces = state?.workspaces
      .filter { $0.project == project.name }
      .sorted { workspaceSortKey($0) < workspaceSortKey($1) } ?? []
    if projectWorkspaces.isEmpty {
      menu.addItem(disabledItem("No workspaces"))
    } else {
      menu.addItem(disabledItem("Workspaces"))
      for workspace in projectWorkspaces {
        let title = workspace.status == "active"
          ? workspace.name
          : "\(workspace.name) (\(workspace.status))"
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = workspaceMenu(workspace)
        menu.addItem(item)
      }
    }

    menu.addItem(.separator())
    menu.addItem(actionItem("Open Repository", action: #selector(openPath(_:)), object: project.repoPath))
    menu.addItem(actionItem("Copy Repository Path", action: #selector(copyPath(_:)), object: project.repoPath))
    if let worktreesDir = project.worktreesDir {
      menu.addItem(actionItem("Open Worktrees", action: #selector(openPath(_:)), object: worktreesDir))
    }
    return menu
  }

  private func workspaceSortKey(_ workspace: Workspace) -> String {
    let statusRank = workspace.status == "active" ? "0" : "1"
    return "\(statusRank)/\(workspace.name)"
  }

  private func workspaceMenu(_ workspace: Workspace) -> NSMenu {
    let menu = NSMenu()
    menu.addItem(disabledItem("Branch: \(workspace.branch)"))
    menu.addItem(disabledItem("Status: \(workspace.status)"))
    if let prURL = workspace.prUrl, !prURL.isEmpty {
      menu.addItem(actionItem("Open PR", action: #selector(openPR(_:)), object: prURL))
    }
    menu.addItem(.separator())
    if workspace.status == "active" {
      for profile in agentProfileNames() {
        menu.addItem(
          actionItem(
            "Open \(profile) Terminal...",
            action: #selector(startAgentProfile(_:)),
            object: workspaceObject(workspace, agentProfile: profile)
          )
        )
      }
      menu.addItem(.separator())
      menu.addItem(
        actionItem(
          "Check Status",
          action: #selector(checkWorkspace(_:)),
          object: workspaceObject(workspace)
        )
      )
      menu.addItem(.separator())
      menu.addItem(
        actionItem(
          "Archive Workspace",
          action: #selector(archiveWorkspace(_:)),
          object: workspaceObject(workspace)
        )
      )
      menu.addItem(
        actionItem(
          "Remove Worktree...",
          action: #selector(removeWorkspace(_:)),
          object: workspaceObject(workspace)
        )
      )
    } else {
      menu.addItem(disabledItem("Workspace is \(workspace.status)"))
    }
    menu.addItem(actionItem("Open Worktree", action: #selector(openPath(_:)), object: workspace.path))
    menu.addItem(actionItem("Copy Path", action: #selector(copyPath(_:)), object: workspace.path))
    return menu
  }

  private func sessionMenu(_ session: Session) -> NSMenu {
    let menu = NSMenu()
    menu.addItem(disabledItem("Status: \(session.status)"))
    menu.addItem(disabledItem("ID: \(session.id)"))
    if session.status == "ready", let runCommand = session.runCommand, !runCommand.isEmpty {
      menu.addItem(actionItem("Copy Start Command", action: #selector(copyText(_:)), object: runCommand))
    }
    if let resumeCommand = session.resumeCommand, !resumeCommand.isEmpty {
      menu.addItem(actionItem("Copy Resume Command", action: #selector(copyText(_:)), object: resumeCommand))
    }
    if let cwd = session.cwd, !cwd.isEmpty {
      if menu.items.count > 2 {
        menu.addItem(.separator())
      }
      menu.addItem(actionItem("Open Folder", action: #selector(openPath(_:)), object: cwd))
      menu.addItem(actionItem("Copy Folder Path", action: #selector(copyPath(_:)), object: cwd))
    }
    menu.addItem(.separator())
    menu.addItem(
      actionItem(
        "Close Session...",
        action: #selector(closeSession(_:)),
        object: sessionObject(session)
      )
    )
    return menu
  }

  private func settingsMenu(_ settings: SettingsState?) -> NSMenu {
    let menu = NSMenu()
    let terminalSetting = settings?.terminalApp ?? "auto"
    let notifications = settings?.notifications
    let enabled = notifications?.enabled ?? true
    let bannerEnabled = notifications?.macosNotification ?? false
    let soundName = notifications?.soundName ?? "Glass"

    menu.addItem(disabledItem("Terminal: \(service.terminalDescription(for: terminalSetting))"))
    menu.addItem(disabledItem("Default Agent: \(defaultAgentProfileLabel(settings))"))
    menu.addItem(disabledItem("Notifications: \(enabled ? "On" : "Off")"))
    menu.addItem(disabledItem("Sound: \(soundName)"))
    menu.addItem(disabledItem("macOS Banner: \(bannerEnabled ? "On" : "Off")"))
    menu.addItem(.separator())

    let terminalItem = NSMenuItem(title: "Terminal App", action: nil, keyEquivalent: "")
    terminalItem.submenu = terminalMenu(current: terminalSetting)
    menu.addItem(terminalItem)

    let agentItem = NSMenuItem(title: "Agent Profiles", action: nil, keyEquivalent: "")
    agentItem.submenu = agentProfilesMenu(currentAgentProfiles(settings))
    menu.addItem(agentItem)

    let notificationsItem = actionItem(
      enabled ? "Turn Notifications Off" : "Turn Notifications On",
      action: #selector(toggleNotifications(_:)),
      object: enabled
    )
    notificationsItem.state = enabled ? .on : .off
    menu.addItem(notificationsItem)

    let bannerItem = actionItem(
      bannerEnabled ? "Turn Banner Off" : "Turn Banner On",
      action: #selector(toggleBanner(_:)),
      object: bannerEnabled
    )
    bannerItem.state = bannerEnabled ? .on : .off
    menu.addItem(bannerItem)

    let soundItem = NSMenuItem(title: "Sound", action: nil, keyEquivalent: "")
    soundItem.submenu = soundMenu(current: soundName)
    menu.addItem(soundItem)

    menu.addItem(actionItem("Test Notification", action: #selector(testNotification(_:))))
    menu.addItem(.separator())

    let hooks = settings?.agentHooks
    menu.addItem(disabledItem("Claude Hook: \(hooks?.claude?.installedAt == nil ? "Not Installed" : "Installed")"))
    menu.addItem(disabledItem("Codex Hook: \(hooks?.codex?.installedAt == nil ? "Not Installed" : "Installed")"))
    menu.addItem(actionItem("Install All Hooks", action: #selector(installHooks(_:)), object: "all"))
    menu.addItem(actionItem("Install Claude Hook", action: #selector(installHooks(_:)), object: "claude"))
    menu.addItem(actionItem("Install Codex Hook", action: #selector(installHooks(_:)), object: "codex"))
    menu.addItem(.separator())
    menu.addItem(actionItem("Remove All Hooks", action: #selector(removeHooks(_:)), object: "all"))
    menu.addItem(actionItem("Remove Claude Hook", action: #selector(removeHooks(_:)), object: "claude"))
    menu.addItem(actionItem("Remove Codex Hook", action: #selector(removeHooks(_:)), object: "codex"))
    return menu
  }

  private func currentTerminalSetting() -> String {
    state?.settings?.terminalApp ?? "auto"
  }

  private func currentTerminalArgument() -> String {
    service.terminalArgument(for: currentTerminalSetting())
  }

  private func defaultAgentProfileLabel(_ settings: SettingsState?) -> String {
    guard let name = currentAgentProfiles(settings)?.default, !name.isEmpty else { return "claude" }
    return name
  }

  private func projectAgentProfileLabel(_ project: Project) -> String {
    if let profile = project.agentProfile, !profile.isEmpty { return profile }
    if let profile = project.claudeProfile, !profile.isEmpty { return profile }
    return "default (\(defaultAgentProfileLabel(state?.settings)))"
  }

  private func agentProfileNames() -> [String] {
    agentProfileEntries(currentAgentProfiles(state?.settings)).map(\.0)
  }

  private func currentAgentProfiles(_ settings: SettingsState?) -> AgentProfilesState? {
    settings?.agentProfiles ?? settings?.claudeProfiles
  }

  private func agentProfilesMenu(_ profiles: AgentProfilesState?) -> NSMenu {
    let menu = NSMenu()
    let defaultName = profiles?.default ?? "claude"
    let entries = agentProfileEntries(profiles)
    for (name, profile) in entries {
      let title = name == defaultName ? "✓ \(name) -> \(profile.command)" : "\(name) -> \(profile.command)"
      let item = actionItem(title, action: #selector(setDefaultAgentProfile(_:)), object: name)
      item.state = name == defaultName ? .on : .off
      menu.addItem(item)
    }
    menu.addItem(.separator())
    menu.addItem(actionItem("Add Profile...", action: #selector(addAgentProfile(_:))))
    return menu
  }

  private func agentProfileEntries(_ profiles: AgentProfilesState?) -> [(String, AgentProfileState)] {
    var entries = profiles?.profiles ?? [:]
    if entries["claude"] == nil {
      entries["claude"] = AgentProfileState(name: "claude", command: "claude")
    }
    if entries["codex"] == nil {
      entries["codex"] = AgentProfileState(name: "codex", command: "codex")
    }
    return entries.sorted { agentProfileSortKey($0.key) < agentProfileSortKey($1.key) }
  }

  private func agentProfileSortKey(_ name: String) -> String {
    if name == "claude" { return "0" }
    if name == "codex" { return "1" }
    return "2-\(name)"
  }

  private func terminalMenu(current: String) -> NSMenu {
    let menu = NSMenu()
    let options = [
      ("Auto", "auto"),
      ("Terminal", "terminal"),
      ("iTerm", "iterm"),
      ("Warp", "warp"),
      ("Warp Preview", "warppreview"),
    ]
    let normalizedCurrent = service.terminalArgument(for: current)
    for (title, value) in options {
      let label = value == "auto" ? service.terminalDescription(for: "auto") : title
      let item = actionItem(label, action: #selector(setTerminal(_:)), object: value)
      item.state = value == normalizedCurrent ? .on : .off
      menu.addItem(item)
    }
    return menu
  }

  private func soundMenu(current: String) -> NSMenu {
    let menu = NSMenu()
    for sound in ["Glass", "Ping", "Pop", "Hero", "Submarine", "Tink", "none"] {
      let title = sound == "none" ? "No Sound" : sound
      let item = actionItem(title, action: #selector(setSound(_:)), object: sound)
      item.state = sound == current ? .on : .off
      menu.addItem(item)
    }
    return menu
  }

  @objc private func startAgentProfile(_ sender: NSMenuItem) {
    guard let workspace = sender.representedObject as? [String: String],
      let agent = workspace["agent"] else { return }
    startAgent(sender, agent: agent)
  }

  private func startAgent(_ sender: NSMenuItem, agent: String) {
    guard let workspace = sender.representedObject as? [String: String],
      let project = workspace["project"],
      let name = workspace["name"] else { return }

    do {
      let output = try service.run([
        "session",
        "start",
        project,
        name,
        "--agent",
        agent,
        "--terminal",
        currentTerminalArgument(),
      ])
      copyPreparedSessionCommand(output: output)
      refresh(silent: true)
    } catch {
      showError(title: "Unable to prepare \(agent)", message: error.localizedDescription)
    }
  }

  @objc private func checkWorkspace(_ sender: NSMenuItem) {
    guard let workspace = sender.representedObject as? [String: String],
      let project = workspace["project"],
      let name = workspace["name"] else { return }

    do {
      let output = try service.run(["checks", project, name])
      showInfo(title: "\(project)/\(name)", message: output)
    } catch {
      showError(title: "Unable to check workspace", message: error.localizedDescription)
    }
  }

  @objc private func createWorkspace(_ sender: NSMenuItem) {
    guard let project = sender.representedObject as? [String: String],
      let projectName = project["name"] else { return }

    let base = project["mainBranch"] ?? "origin/main"
    guard let form = workspaceCreationForm(projectName: projectName, base: base) else {
      return
    }

    var args = ["workspace", "create", projectName, form.name]
    if !form.base.isEmpty {
      args.append(contentsOf: ["--base", form.base])
    }
    if form.agent != "None" {
      args.append(contentsOf: ["--agent", form.agent, "--terminal", currentTerminalArgument()])
    }

    do {
      let output = try service.run(args)
      if form.agent != "None" {
        copyPreparedSessionCommand(output: output)
      }
      refresh(silent: true)
    } catch {
      showError(title: "Unable to create workspace", message: error.localizedDescription)
    }
  }

  @objc private func archiveWorkspace(_ sender: NSMenuItem) {
    guard let workspace = sender.representedObject as? [String: String],
      let project = workspace["project"],
      let name = workspace["name"] else { return }

    guard confirm(
      title: "Archive Workspace",
      message: "Archive \(project)/\(name)? The worktree stays on disk."
    ) else { return }

    do {
      try service.run(["workspace", "archive", project, name])
      refresh(silent: true)
    } catch {
      showError(title: "Unable to archive workspace", message: error.localizedDescription)
    }
  }

  @objc private func removeWorkspace(_ sender: NSMenuItem) {
    guard let workspace = sender.representedObject as? [String: String],
      let project = workspace["project"],
      let name = workspace["name"] else { return }

    guard confirm(
      title: "Remove Worktree",
      message: "Remove the worktree for \(project)/\(name)? This does not delete the remote PR."
    ) else { return }

    do {
      try service.run(["workspace", "remove", project, name])
      refresh(silent: true)
    } catch {
      showError(title: "Unable to remove worktree", message: error.localizedDescription)
    }
  }

  @objc private func closeSession(_ sender: NSMenuItem) {
    guard let session = sender.representedObject as? [String: String],
      let id = session["id"],
      let project = session["project"],
      let workspace = session["workspace"] else { return }

    guard confirm(
      title: "Close Session",
      message: "Close \(project)/\(workspace) session \(id)?"
    ) else { return }

    do {
      try service.run(["session", "stop", id])
      refresh(silent: true)
    } catch {
      showError(title: "Unable to close session", message: error.localizedDescription)
    }
  }

  @objc private func closeAllSessions(_ sender: NSMenuItem) {
    guard let ids = sender.representedObject as? [String], !ids.isEmpty else { return }

    guard confirm(
      title: "Close All Sessions",
      message: "Close \(ids.count) active conductor session\(ids.count == 1 ? "" : "s")?"
    ) else { return }

    var failures: [String] = []
    for id in ids {
      do {
        try service.run(["session", "stop", id])
      } catch {
        failures.append("\(id): \(error.localizedDescription)")
      }
    }
    refresh(silent: true)
    if !failures.isEmpty {
      showError(title: "Some sessions did not close", message: failures.joined(separator: "\n"))
    }
  }

  @objc private func toggleNotifications(_ sender: NSMenuItem) {
    let currentlyEnabled = sender.representedObject as? Bool ?? true
    runSettings(["notifications", currentlyEnabled ? "off" : "on"], title: "Unable to update notifications")
  }

  @objc private func toggleBanner(_ sender: NSMenuItem) {
    let currentlyEnabled = sender.representedObject as? Bool ?? false
    runSettings(["macos-notification", currentlyEnabled ? "off" : "on"], title: "Unable to update banner setting")
  }

  @objc private func setTerminal(_ sender: NSMenuItem) {
    guard let terminal = sender.representedObject as? String else { return }
    runSettings(["terminal", terminal], title: "Unable to update terminal app")
  }

  @objc private func addAgentProfile(_ sender: Any?) {
    guard let form = agentProfileForm() else { return }
    do {
      try service.run(["agent-profile", "add", form.name, form.command])
      refresh(silent: true)
    } catch {
      showError(title: "Unable to add agent profile", message: error.localizedDescription)
    }
  }

  @objc private func setDefaultAgentProfile(_ sender: NSMenuItem) {
    guard let name = sender.representedObject as? String else { return }
    do {
      try service.run(["agent-profile", "default", name])
      refresh(silent: true)
    } catch {
      showError(title: "Unable to set default agent profile", message: error.localizedDescription)
    }
  }

  @objc private func setProjectAgentProfile(_ sender: NSMenuItem) {
    guard let project = sender.representedObject as? [String: String],
      let name = project["name"] else { return }
    let current = project["agentProfile"] ?? project["claudeProfile"] ?? ""
    guard let profile = chooseAgentProfile(projectName: name, current: current) else { return }
    do {
      try service.run(["project", "set-agent-profile", name, profile])
      refresh(silent: true)
    } catch {
      showError(title: "Unable to set project agent profile", message: error.localizedDescription)
    }
  }

  @objc private func setSound(_ sender: NSMenuItem) {
    guard let sound = sender.representedObject as? String else { return }
    runSettings(["sound", sound], title: "Unable to update sound")
  }

  @objc private func testNotification(_ sender: Any?) {
    runSettings(["test"], title: "Unable to test notification")
  }

  @objc private func installHooks(_ sender: NSMenuItem) {
    guard let target = sender.representedObject as? String else { return }
    runSettings(["hooks", "install", target], title: "Unable to install hooks")
  }

  @objc private func removeHooks(_ sender: NSMenuItem) {
    guard let target = sender.representedObject as? String else { return }
    runSettings(["hooks", "remove", target], title: "Unable to remove hooks")
  }

  private func runSettings(_ arguments: [String], title: String) {
    do {
      try service.run(["settings"] + arguments)
      refresh(silent: true)
    } catch {
      showError(title: title, message: error.localizedDescription)
    }
  }

  private func copyPreparedSessionCommand(output: String) {
    guard let command = runCommand(from: output) else { return }
    copyToPasteboard(command)
  }

  private func runCommand(from output: String) -> String? {
    for line in output.components(separatedBy: .newlines) {
      if line.hasPrefix("run: ") {
        return String(line.dropFirst(5))
      }
    }
    return nil
  }

  @objc private func openPath(_ sender: NSMenuItem) {
    guard let path = sender.representedObject as? String else { return }
    NSWorkspace.shared.open(URL(fileURLWithPath: path))
  }

  @objc private func copyPath(_ sender: NSMenuItem) {
    guard let path = sender.representedObject as? String else { return }
    copyToPasteboard(path)
  }

  @objc private func copyText(_ sender: NSMenuItem) {
    guard let text = sender.representedObject as? String else { return }
    copyToPasteboard(text)
  }

  private func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  @objc private func openPR(_ sender: NSMenuItem) {
    guard let value = sender.representedObject as? String,
      let url = URL(string: value) else { return }
    NSWorkspace.shared.open(url)
  }

  @objc private func registerProject(_ sender: Any?) {
    let panel = NSOpenPanel()
    panel.title = "Choose a Git Repository"
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false

    guard panel.runModal() == .OK, let url = panel.url else { return }
    let repoPath = url.path
    let defaults = registrationDefaults(for: repoPath)
    guard let form = registrationForm(defaults: defaults) else { return }

    var args = ["project", "add", form.name, repoPath]
    if !form.base.isEmpty {
      args.append(contentsOf: ["--base", form.base])
    }
    if !form.githubUser.isEmpty {
      args.append(contentsOf: ["--gh-user", form.githubUser])
    }
    if !form.worktreesDir.isEmpty {
      args.append(contentsOf: ["--worktrees-dir", form.worktreesDir])
    }
    if !form.agentProfile.isEmpty && form.agentProfile != "default" {
      args.append(contentsOf: ["--agent-profile", form.agentProfile])
    }

    do {
      try service.run(args)
      refresh(silent: true)
    } catch {
      showError(title: "Unable to register project", message: error.localizedDescription)
    }
  }

  @objc private func openConfigFolder(_ sender: Any?) {
    guard let configPath = state?.configPath else { return }
    let url = URL(fileURLWithPath: configPath).deletingLastPathComponent()
    NSWorkspace.shared.open(url)
  }

  @objc private func openWorktreesFolder(_ sender: Any?) {
    let paths = state?.projects.compactMap(\.worktreesDir) ?? []
    if let first = paths.first {
      NSWorkspace.shared.open(URL(fileURLWithPath: first).deletingLastPathComponent())
    }
  }

  @objc private func quit(_ sender: Any?) {
    NSApp.terminate(nil)
  }

  private func workspaceObject(_ workspace: Workspace) -> [String: String] {
    [
      "project": workspace.project,
      "name": workspace.name,
      "path": workspace.path,
    ]
  }

  private func workspaceObject(_ workspace: Workspace, agentProfile: String) -> [String: String] {
    [
      "project": workspace.project,
      "name": workspace.name,
      "path": workspace.path,
      "agent": agentProfile,
    ]
  }

  private func sessionObject(_ session: Session) -> [String: String] {
    [
      "id": session.id,
      "project": session.project,
      "workspace": session.workspace,
      "agent": session.agent,
      "status": session.status,
    ]
  }

  private func projectObject(_ project: Project) -> [String: String] {
    [
      "name": project.name,
      "repoPath": project.repoPath,
      "mainBranch": project.mainBranch ?? "origin/main",
      "worktreesDir": project.worktreesDir ?? "",
      "githubUser": project.githubUser ?? "",
      "agentProfile": project.agentProfile ?? "",
      "claudeProfile": project.claudeProfile ?? "",
    ]
  }

  private func registrationDefaults(for repoPath: String) -> RegistrationForm {
    let repoName = URL(fileURLWithPath: repoPath).lastPathComponent
    let projectName = repoName
      .lowercased()
      .replacingOccurrences(of: " ", with: "-")
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return RegistrationForm(
      name: projectName,
      base: "origin/main",
      githubUser: "",
      worktreesDir: "\(home)/.conductor-cli/worktrees/\(projectName)",
      agentProfile: ""
    )
  }

  private func workspaceCreationForm(projectName: String, base: String) -> WorkspaceCreationForm? {
    let nameField = NSTextField(string: "")
    let baseField = NSTextField(string: base)
    let agentPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    agentPopup.addItems(withTitles: ["None"] + agentProfileNames())
    let branchPreview = NSTextField(labelWithString: defaultBranchPreview(projectName: projectName, workspaceName: ""))
    branchPreview.textColor = .secondaryLabelColor
    nameField.delegate = self
    pendingWorkspaceNameField = nameField
    pendingWorkspaceBranchPreview = branchPreview
    pendingWorkspaceProjectName = projectName

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.spacing = 8
    stack.addArrangedSubview(labeledField("Workspace", nameField))
    stack.addArrangedSubview(labeledControl("Branch", branchPreview))
    stack.addArrangedSubview(labeledField("Base ref", baseField))
    stack.addArrangedSubview(labeledControl("Prepare agent", agentPopup))
    stack.frame = NSRect(x: 0, y: 0, width: 360, height: 160)

    let alert = NSAlert()
    alert.messageText = "Create Workspace"
    alert.informativeText = "Project: \(projectName)"
    alert.accessoryView = stack
    alert.addButton(withTitle: "Create")
    alert.addButton(withTitle: "Cancel")

    let response = alert.runModal()
    pendingWorkspaceNameField = nil
    pendingWorkspaceBranchPreview = nil
    pendingWorkspaceProjectName = nil

    guard response == .alertFirstButtonReturn else { return nil }
    let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else {
      showError(title: "Workspace name required", message: "Enter a workspace name.")
      return nil
    }

    return WorkspaceCreationForm(
      name: name,
      base: baseField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
      agent: agentPopup.titleOfSelectedItem ?? "None"
    )
  }

  func controlTextDidChange(_ obj: Notification) {
    guard let field = obj.object as? NSTextField,
      field === pendingWorkspaceNameField,
      let preview = pendingWorkspaceBranchPreview,
      let projectName = pendingWorkspaceProjectName else { return }

    preview.stringValue = defaultBranchPreview(
      projectName: projectName,
      workspaceName: field.stringValue
    )
  }

  private func defaultBranchPreview(projectName: String, workspaceName: String) -> String {
    let username = defaultGitHubUser(projectName: projectName)
    let rawWorkspace = workspaceName.trimmingCharacters(in: .whitespacesAndNewlines)
    let workspace = rawWorkspace.isEmpty ? "<workspace>" : sanitizeBranchSegment(rawWorkspace)
    return "\(username)/\(workspace)"
  }

  private func defaultGitHubUser(projectName: String) -> String {
    if let project = state?.projects.first(where: { $0.name == projectName }),
      let value = project.githubUser,
      !value.isEmpty {
      return sanitizeBranchSegment(value)
    }
    let environment = ProcessInfo.processInfo.environment
    if let value = environment["GH_USER"] ?? environment["GITHUB_USER"], !value.isEmpty {
      return sanitizeBranchSegment(value)
    }
    return "conductor"
  }

  private func sanitizeBranchSegment(_ value: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
    let scalars = value.lowercased().unicodeScalars.map { scalar -> Character in
      allowed.contains(scalar) ? Character(scalar) : "-"
    }
    let collapsed = String(scalars)
      .split(separator: "-", omittingEmptySubsequences: true)
      .joined(separator: "-")
    return collapsed.isEmpty ? "workspace" : collapsed
  }

  private func agentProfileForm() -> AgentProfileForm? {
    let nameField = NSTextField(string: "")
    let commandField = NSTextField(string: "claude")

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.spacing = 8
    stack.addArrangedSubview(labeledField("Profile name", nameField))
    stack.addArrangedSubview(labeledField("Command", commandField))
    stack.frame = NSRect(x: 0, y: 0, width: 360, height: 96)

    let alert = NSAlert()
    alert.messageText = "Add Agent Profile"
    alert.informativeText = "Profiles are stored by conductor-cli and can be assigned to projects."
    alert.accessoryView = stack
    alert.addButton(withTitle: "Add")
    alert.addButton(withTitle: "Cancel")

    guard alert.runModal() == .alertFirstButtonReturn else { return nil }
    let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let command = commandField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, !command.isEmpty else {
      showError(title: "Profile name and command required", message: "Enter both a profile name and command.")
      return nil
    }
    return AgentProfileForm(name: name, command: command)
  }

  private func chooseAgentProfile(projectName: String, current: String) -> String? {
    let popup = NSPopUpButton(frame: .zero, pullsDown: false)
    popup.addItem(withTitle: "Default")
    for profile in agentProfileNames() {
      popup.addItem(withTitle: profile)
    }
    if !current.isEmpty, let item = popup.item(withTitle: current) {
      popup.select(item)
    } else {
      popup.selectItem(withTitle: "Default")
    }

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.spacing = 8
    stack.addArrangedSubview(labeledControl("Agent profile", popup))
    stack.frame = NSRect(x: 0, y: 0, width: 360, height: 64)

    let alert = NSAlert()
    alert.messageText = "Set Agent Profile"
    alert.informativeText = "Project: \(projectName)"
    alert.accessoryView = stack
    alert.addButton(withTitle: "Set")
    alert.addButton(withTitle: "Cancel")

    guard alert.runModal() == .alertFirstButtonReturn else { return nil }
    let selected = popup.titleOfSelectedItem ?? "Default"
    return selected == "Default" ? "default" : selected
  }

  private func registrationForm(defaults: RegistrationForm) -> RegistrationForm? {
    let nameField = NSTextField(string: defaults.name)
    let baseField = NSTextField(string: defaults.base)
    let githubUserField = NSTextField(string: defaults.githubUser)
    let agentProfilePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    agentProfilePopup.addItem(withTitle: "Default")
    for profile in agentProfileNames() {
      agentProfilePopup.addItem(withTitle: profile)
    }
    if !defaults.agentProfile.isEmpty, let item = agentProfilePopup.item(withTitle: defaults.agentProfile) {
      agentProfilePopup.select(item)
    }
    let worktreesField = NSTextField(string: defaults.worktreesDir)

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.spacing = 8
    stack.addArrangedSubview(labeledField("Project name", nameField))
    stack.addArrangedSubview(labeledField("Base ref", baseField))
    stack.addArrangedSubview(labeledField("GitHub user", githubUserField))
    stack.addArrangedSubview(labeledControl("Agent profile", agentProfilePopup))
    stack.addArrangedSubview(labeledField("Worktrees dir", worktreesField))
    stack.frame = NSRect(x: 0, y: 0, width: 360, height: 192)

    let alert = NSAlert()
    alert.messageText = "Register Project"
    alert.informativeText = "This will call conductor-cli project add."
    alert.accessoryView = stack
    alert.addButton(withTitle: "Register")
    alert.addButton(withTitle: "Cancel")

    guard alert.runModal() == .alertFirstButtonReturn else { return nil }
    let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else {
      showError(title: "Project name required", message: "Enter a project name.")
      return nil
    }

    return RegistrationForm(
      name: name,
      base: baseField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
      githubUser: githubUserField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
      worktreesDir: worktreesField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
      agentProfile: agentProfilePopup.titleOfSelectedItem == "Default"
        ? "default"
        : (agentProfilePopup.titleOfSelectedItem ?? "default")
    )
  }

  private func labeledField(_ label: String, _ field: NSTextField) -> NSView {
    let row = NSStackView()
    row.orientation = .horizontal
    row.spacing = 8

    let labelView = NSTextField(labelWithString: label)
    labelView.alignment = .right
    labelView.widthAnchor.constraint(equalToConstant: 96).isActive = true

    field.widthAnchor.constraint(equalToConstant: 240).isActive = true
    row.addArrangedSubview(labelView)
    row.addArrangedSubview(field)
    return row
  }

  private func labeledControl(_ label: String, _ control: NSView) -> NSView {
    let row = NSStackView()
    row.orientation = .horizontal
    row.spacing = 8

    let labelView = NSTextField(labelWithString: label)
    labelView.alignment = .right
    labelView.widthAnchor.constraint(equalToConstant: 96).isActive = true

    control.widthAnchor.constraint(equalToConstant: 240).isActive = true
    row.addArrangedSubview(labelView)
    row.addArrangedSubview(control)
    return row
  }

  private func disabledItem(_ title: String) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    return item
  }

  private func actionItem(
    _ title: String,
    action: Selector,
    object: Any? = nil
  ) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
    item.target = self
    item.representedObject = object
    return item
  }

  private func showInfo(title: String, message: String) {
    showAlert(style: .informational, title: title, message: message)
  }

  private func showError(title: String, message: String) {
    showAlert(style: .warning, title: title, message: message)
  }

  private func showAlert(style: NSAlert.Style, title: String, message: String) {
    let alert = NSAlert()
    alert.alertStyle = style
    alert.messageText = title
    alert.informativeText = message
    alert.runModal()
  }

  private func confirm(title: String, message: String) -> Bool {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = title
    alert.informativeText = message
    alert.addButton(withTitle: "Continue")
    alert.addButton(withTitle: "Cancel")
    return alert.runModal() == .alertFirstButtonReturn
  }
}

if CommandLine.arguments.contains("--check-state") {
  do {
    let state = try ConductorService().loadState()
    print("ok \(state.projects.count) projects \(state.workspaces.count) workspaces")
    exit(0)
  } catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
