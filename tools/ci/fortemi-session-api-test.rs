// Exercise pinned Fortemi API routes against an isolated session archive.
#[tokio::test]
async fn aiwg_session_full_v1_api_conformance() {
    use base64::Engine;
    use tower::ServiceExt;

    async fn request(app: &Router, method: &str, path: &str, body: String) -> Vec<u8> {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            status,
            StatusCode::OK,
            "{method} {path}: {}",
            String::from_utf8_lossy(&bytes)
        );
        bytes.to_vec()
    }

    let _guard = SHARD_INTEGRATION_TEST_LOCK.lock().await;
    let database_url = std::env::var("DATABASE_URL").expect("isolated DATABASE_URL is required");
    let storage = tempfile::tempdir().unwrap();
    let db = Database::connect(&database_url)
        .await
        .unwrap()
        .with_filesystem_storage(&storage.path().to_string_lossy(), 0);
    let state = build_call_api_test_state(db.clone(), &database_url).await;
    let name = format!("aiwg-session-{}", Uuid::new_v4().simple());
    let destination = db
        .archives
        .create_archive_schema(&name, Some("AIWG synthetic session conformance"))
        .await
        .unwrap();
    let app = Router::new()
        .route(
            "/api/v1/backup/knowledge-shard/import",
            post(knowledge_shard_import),
        )
        .route("/api/v1/backup/knowledge-shard", get(knowledge_shard))
        .route("/api/v1/notes/{id}", get(get_note))
        .route("/api/v1/notes/{id}/provenance", get(get_note_provenance))
        .layer(Extension(ArchiveContext {
            schema: destination.schema_name.clone(),
            is_default: false,
            name: Some(name.clone()),
        }))
        .with_state(state);
    let archive = std::fs::read(std::env::var("AIWG_SESSION_SHARD").unwrap()).unwrap();
    let files = read_shard_archive(&archive, ShardArchiveLimits::default()).unwrap();
    let notes = parse_shard_component_records("notes", &files["notes.jsonl"]).unwrap();
    let activities = parse_shard_component_records(
        "provenance_activities",
        &files["provenance_activities.jsonl"],
    )
    .unwrap();
    assert!(notes
        .iter()
        .any(|note| note["metadata"]["aiwg_source"]["record_type"] == "aiwg.session"));
    assert!(notes
        .iter()
        .any(|note| note["metadata"]["aiwg_source"]["record_type"] == "aiwg.session-event"));
    let import_body = |bytes: &[u8]| {
        serde_json::json!({
            "shard_base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "on_conflict": "replace", "skip_embedding_regen": true
        })
        .to_string()
    };
    // Rejection must leave the fresh destination empty.
    let rejected = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/v1/backup/knowledge-shard/import")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(import_body(b"not a gzip archive")))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(!rejected.status().is_success());
    let empty = request(
        &app,
        "GET",
        "/api/v1/backup/knowledge-shard?schema_version=2.0.0&profile=full-v1",
        String::new(),
    )
    .await;
    let empty_files = read_shard_archive(&empty, ShardArchiveLimits::default()).unwrap();
    assert!(
        parse_shard_component_records("notes", &empty_files["notes.jsonl"])
            .unwrap()
            .is_empty()
    );
    for _ in 0..2 {
        request(
            &app,
            "POST",
            "/api/v1/backup/knowledge-shard/import",
            import_body(&archive),
        )
        .await;
    }
    let mut observed = Vec::new();
    for note in &notes {
        let id = note["id"].as_str().unwrap();
        let fetched: serde_json::Value = serde_json::from_slice(
            &request(&app, "GET", &format!("/api/v1/notes/{id}"), String::new()).await,
        )
        .unwrap();
        assert_eq!(
            fetched["note"]["metadata"]["aiwg_source"],
            note["metadata"]["aiwg_source"]
        );
        assert_eq!(fetched["note"]["title"], note["title"]);
        assert_eq!(fetched["original"]["content"], note["original_content"]);
        let provenance: serde_json::Value = serde_json::from_slice(
            &request(
                &app,
                "GET",
                &format!("/api/v1/notes/{id}/provenance"),
                String::new(),
            )
            .await,
        )
        .unwrap();
        for expected in activities
            .iter()
            .filter(|activity| activity["note_id"] == note["id"])
        {
            let found = provenance["all_activities"]
                .as_array()
                .unwrap()
                .iter()
                .find(|activity| activity["id"] == expected["id"])
                .expect("API exposes analysis provenance");
            assert_eq!(found["activity_type"], expected["activity_type"]);
            assert_eq!(found["metadata"], expected["metadata"]);
        }
        observed.push(serde_json::json!({"note": fetched, "provenance": provenance}));
    }
    let reexported = request(
        &app,
        "GET",
        "/api/v1/backup/knowledge-shard?schema_version=2.0.0&profile=full-v1&include_blobs=true",
        String::new(),
    )
    .await;
    std::fs::write(std::env::var("AIWG_SESSION_REEXPORT").unwrap(), reexported).unwrap();
    std::fs::write(
        std::env::var("AIWG_SESSION_API_OBSERVATIONS").unwrap(),
        serde_json::to_vec_pretty(&observed).unwrap(),
    )
    .unwrap();
    db.archives.drop_archive_schema(&name).await.unwrap();
}
