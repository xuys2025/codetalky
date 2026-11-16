# CodeTalky device firmware (ESP-IDF v5.5.4, ESP32-S3).
# Build inside WSL with firmware/build.sh; flash from Windows with firmware/flash.ps1.
cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(codetalky)
