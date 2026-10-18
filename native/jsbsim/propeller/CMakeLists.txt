# TASK-086: native load/thrust probe for the UIUC-derived propeller definitions.
# A separate project so the pinned bridge/backend build (../CMakeLists.txt), whose
# hash is recorded in TASK-031 evidence, stays unchanged.
cmake_minimum_required(VERSION 3.20)
project(mirage_jsbsim_propeller LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
if(NOT DEFINED JSBSIM_SOURCE_DIR)
  message(FATAL_ERROR "JSBSIM_SOURCE_DIR must point to the verified pinned checkout")
endif()
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_PYTHON_MODULE OFF CACHE BOOL "" FORCE)
add_subdirectory("${JSBSIM_SOURCE_DIR}" upstream EXCLUDE_FROM_ALL)
add_executable(mirage_jsbsim_propeller_probe ../propeller_probe.cpp)
target_link_libraries(mirage_jsbsim_propeller_probe PRIVATE libJSBSim)
