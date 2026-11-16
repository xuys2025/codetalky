# The UI in ui/ is shared with the simulator; this component adds the device side.
# build.sh copies firmware/, ui/ and third_party/monocypher into one tree, so the
# paths below are the same whether the tree is the repo or that copy.
set(ROOT ${CMAKE_CURRENT_LIST_DIR}/../..)

file(GLOB UI_SRCS ${ROOT}/ui/src/*.c)
file(GLOB FONT_SRCS ${ROOT}/ui/fonts/gen/*.c)
file(GLOB OWN_SRCS ${CMAKE_CURRENT_LIST_DIR}/*.c)

idf_component_register(
    SRCS ${OWN_SRCS} ${UI_SRCS} ${FONT_SRCS} ${ROOT}/third_party/monocypher/monocypher.c
    INCLUDE_DIRS . ${ROOT}/ui/include ${ROOT}/ui/src ${ROOT}/ui/fonts/gen ${ROOT}/third_party/monocypher
    REQUIRES lvgl json esp_lcd esp_driver_gpio esp_driver_spi esp_driver_i2c esp_wifi esp_netif
             esp_event nvs_flash esp_timer lwip esp_websocket_client esp_hw_support esp_pm
             app_update esp_app_format esp_http_client mbedtls esp_driver_i2s esp_driver_uart)

# Third-party code and generated fonts: not ours to keep warning-free.
set_source_files_properties(${ROOT}/third_party/monocypher/monocypher.c ${FONT_SRCS}
    PROPERTIES COMPILE_OPTIONS "-w")
