use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewBuilder, WebviewUrl, WindowBuilder,
};

fn invoke(
    webview: &tauri::Webview<MockRuntime>,
    command: &str,
    origin: &str,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    struct BorrowedWebview<'a>(&'a tauri::Webview<MockRuntime>);
    impl AsRef<tauri::Webview<MockRuntime>> for BorrowedWebview<'_> {
        fn as_ref(&self) -> &tauri::Webview<MockRuntime> {
            self.0
        }
    }
    get_ipc_response(
        &BorrowedWebview(webview),
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: origin.parse().unwrap(),
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
}

#[test]
fn native_command_permissions_isolate_webviews() {
    let builder = mock_builder()
        // A marker handler proves which requests pass the real generated ACL,
        // without starting terminals, importing plugins or showing notifications.
        .invoke_handler(|request| {
            request.resolver.resolve("authorized");
            true
        });
    #[cfg(all(feature = "native-mcp", target_os = "macos"))]
    let builder = builder.plugin(
        tauri::plugin::Builder::<MockRuntime>::new("mcp-bridge")
            .invoke_handler(|request| {
                request.resolver.resolve("authorized");
                true
            })
            .build(),
    );
    let app = builder.build(super::app_context()).unwrap();
    let main_window = WindowBuilder::new(&app, "main").build().unwrap();
    let main = main_window
        .add_child(
            WebviewBuilder::new("main", WebviewUrl::default()),
            tauri::LogicalPosition::new(0, 0),
            tauri::LogicalSize::new(800, 600),
        )
        .unwrap();
    // Production uses a raw Wry guest with no IPC. A simulated Tauri sibling
    // catches accidental window-wide grants in the main window's capability.
    let guest = main_window
        .add_child(
            WebviewBuilder::new("browser-content", WebviewUrl::default()),
            tauri::LogicalPosition::new(500, 80),
            tauri::LogicalSize::new(300, 500),
        )
        .unwrap();

    let huddle = tauri::WebviewWindowBuilder::new(&app, "huddle", WebviewUrl::default())
        .build()
        .unwrap();

    let application_commands = [
        "identity_restore",
        "identity_import",
        "identity_legacy_available",
        "identity_import_legacy",
        "identity_create",
        "identity_export",
        "nsec_backup_available",
        "nsec_backup_session",
        "nsec_backup_retry",
        "nsec_backup_state",
        "nsec_backup_watch",
        "nsec_restore_begin",
        "nsec_restore_wait",
        "nsec_restore_install",
        "nsec_restore_cancel",
        "nsec_backup_choice",
        "nsec_backup_set_choice",
        "relay_sign",
        "identity_prepare_remote_agent_authorization",
        "identity_sign_builderlab_binding",
        "relay_decode_read_state",
        "relay_sign_read_state",
        "relay_publish_read_state",
        "relay_http",
        "relay_workflow_runs",
        "relay_project_git",
        "relay_project_git_cancel",
        "relay_channel_sign",
        "relay_channel_publish",
        "relay_kit_sign",
        "relay_kit_prepare",
        "relay_kit_decode",
        "relay_direct_message",
        "relay_decode_sidebar",
        "relay_sign_sidebar",
        "relay_decode_reminders",
        "relay_sign_reminder",
        "relay_agent_resolve",
        "relay_git_authorization",
        "relay_agent_log_proof",
        "relay_agent_observer",
        "relay_archive",
        "relay_agent_memories_read",
        "relay_agent_library",
        "relay_upload_begin",
        "relay_upload_chunk",
        "relay_upload",
        "relay_upload_cancel",
        "media_download",
        "file_download",
        "media_copy_image",
        "media_stream_base",
        "get_os_idle_seconds",
        "plugin_import_folder",
        "plugin_update_check",
        "plugin_update_preview",
        "plugin_import_git",
        "plugin_import_install",
        "plugin_import_discard",
        "plugin_catalog",
        "plugin_change",
        "plugin_reload",
        "plugin_module",
        "plugin_recover",
        "plugin_host_run_command",
        "plugin_host_request",
        "plugin_host_upload",
        "plugin_host_process_spawn",
        "plugin_host_process_write",
        "plugin_host_process_kill",
        "plugin_host_mcp_serve",
        "plugin_host_mcp_reply",
        "plugin_host_mcp_close",
        "plugin_host_read_file",
        "plugin_host_resolve_directory",
        "oauth_callback_begin",
        "oauth_callback_wait",
        "oauth_callback_cancel",
        "app_agent_list",
        "app_agent_create",
        "app_agent_portable",
        "app_agent_port",
        "app_agent_rename",
        "app_agent_set_picture",
        "app_agent_set_type",
        "app_agent_delete",
        "app_agent_begin_delete",
        "app_agent_begin_leave",
        "app_agent_join",
        "app_agent_forget",
        "app_agent_publish",
        "app_agent_publish_profile",
        "app_agent_query",
        "app_agent_search_profiles",
        "app_agent_upload",
        "app_agent_media",
        "app_agent_git_auth",
        "app_agent_remember",
        "app_agent_claim",
        "app_agent_release",
        "jev_classifier_status",
        "jev_classifier_set_key",
        "jev_classifier_clear_key",
        "app_agent_state_load",
        "app_agent_state_set",
        "decide",
        "title_bar_double_click",
        "notification_show",
        #[cfg(target_os = "macos")]
        "notification_permission_state",
        #[cfg(target_os = "macos")]
        "request_notification_access",
        "dock_permission",
        "unread_indicator_set",
        "keep_awake_set",
        "deep_link_take",
        "deep_link_watch",
        "terminal_create_owner",
        "terminal_spawn",
        "terminal_read",
        "terminal_write",
        "terminal_resize",
        "terminal_close",
        "terminal_close_owner",
        "update_restart",
        "browser_attach",
        "browser_set_bounds",
        "browser_detach",
        "browser_navigate",
        "browser_action",
        "browser_status",
    ];
    let local_origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    // Window fallback belongs to trusted app UI, never a sibling or remote page.
    for origin in [local_origin, "https://example.org", "http://localhost:1430"] {
        assert!(invoke(&guest, "plugin:window|close", origin).is_err());
    }
    assert!(invoke(&main, "plugin:window|close", "https://example.org").is_err());
    // The removed owner attestation cannot acquire a main-webview grant.
    assert!(invoke(&main, "relay_agent_authorize", local_origin).is_err());
    assert!(invoke(&main, "relay_agent_history_decode", local_origin).is_err());
    for command in application_commands {
        assert!(invoke(&main, command, local_origin).is_ok(), "{command}");
        assert_eq!(
            invoke(huddle.as_ref(), command, local_origin).is_ok(),
            command == "media_download",
            "huddle must only acquire the bounded download command: {command}"
        );
        assert!(invoke(huddle.as_ref(), command, "https://example.org").is_err());
        for origin in [local_origin, "https://example.org", "http://localhost:1430"] {
            assert!(
                invoke(&guest, command, origin).is_err(),
                "guest must reject {command} from {origin}"
            );
        }
        assert!(
            invoke(&main, command, "https://example.org").is_err(),
            "remote content must not use main grants: {command}"
        );
    }
    assert!(invoke(&main, "plugin:window|close", local_origin).is_ok());

    #[cfg(all(feature = "native-mcp", target_os = "macos"))]
    {
        use tauri::Manager as _;
        let callbacks = [
            "script_result",
            "request_script_injection",
            "report_ipc_event",
        ];
        for callback in callbacks {
            assert!(invoke(
                &main,
                &format!("plugin:mcp-bridge|{callback}"),
                local_origin
            )
            .is_err());
        }
        // Apply the actual opt-in overlay capability through Tauri's ACL resolver.
        // The marker plugin has no bridge server or identity side effects.
        let overlay: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.native-mcp.conf.json")).unwrap();
        for capability in overlay["app"]["security"]["capabilities"]
            .as_array()
            .unwrap()
        {
            if capability.is_object() {
                app.add_capability(capability.to_string()).unwrap();
            }
        }
        for callback in callbacks {
            let command = format!("plugin:mcp-bridge|{callback}");
            assert!(invoke(&main, &command, local_origin).is_ok(), "{command}");
            assert!(invoke(&main, &command, "https://example.org").is_err());
            assert!(invoke(&guest, &command, local_origin).is_err());
            assert!(invoke(huddle.as_ref(), &command, local_origin).is_err());
        }
        assert!(invoke(&main, "plugin:mcp-bridge|execute_command", local_origin).is_err());
        assert!(invoke(&main, "identity_restore", local_origin).is_ok());
    }
}
